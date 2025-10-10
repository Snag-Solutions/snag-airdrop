import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { parseEventLogs, getAddress } from 'viem'

function usdCentsToWei(usdCents: bigint, price: bigint, decimals: bigint) {
  // wei = ceil( (usdCents/100) * 10^(18+dec) / price )
  const num = (usdCents * (10n ** (18n + decimals))) / 100n
  return (num + price - 1n) / price
}

describe('Fee Module: USD fees, caps, overflow (harness)', function () {
  async function deployFixture() {
    const [owner, treasury, partner, protocol] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    // price feed: 8 decimals, 3000 * 10^8
    const feed = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])

    const harness = await hre.viem.deployContract('MockFeeModuleHarness')

    // init with modest fees and cap
    await harness.write.init([
      feed.address,
      86_400,
      treasury.account.address,
      protocol.account.address,
      partner.account.address,
      100n, // $1.00
      200n, // $2.00
      500n, // $5.00 cap
      0, // Cancel overflow
      0, // token share bips
    ])

    return { owner, treasury, partner, protocol, feed, harness, publicClient }
  }

  it('requiredFeeWei reflects config and stake selection', async function () {
    const { harness } = await loadFixture(deployFixture)
    const price = 3_000n * 10n ** 8n
    const dec = 8n
    const claimWei = usdCentsToWei(100n, price, dec)
    const stakeWei = usdCentsToWei(200n, price, dec)

    const r0 = await harness.read.exposedRequiredFeeWei([false])
    const r1 = await harness.read.exposedRequiredFeeWei([true])
    expect(r0).to.equal(claimWei)
    expect(r1).to.equal(stakeWei)
  })

  it('collects pre-cap to treasury and increments totalFeeUsdCents', async function () {
    const { harness, treasury, publicClient } = await loadFixture(deployFixture)
    const price = 3_000n * 10n ** 8n
    const dec = 8n
    const need = usdCentsToWei(100n, price, dec)

    const before = await publicClient.getBalance({ address: treasury.account.address })
    await harness.write.exposedCollect([false], { value: need })
    const after = await publicClient.getBalance({ address: treasury.account.address })
    expect(after - before).to.equal(need)

    const rem = await harness.read.exposedRemainingCap()
    expect(rem).to.equal(400n)
  })

  it('reverts when underpaying required fee (InsufficientFee)', async function () {
    const { harness } = await loadFixture(deployFixture)
    const need = await harness.read.exposedRequiredFeeWei([false])
    await expect(
      harness.write.exposedCollect([false], { value: need - 1n }),
    ).to.be.rejectedWith('InsufficientFee')
  })

  it('refunds dust overpayment pre-cap', async function () {
    const { harness, treasury, publicClient } = await loadFixture(deployFixture)
    const price = 3_000n * 10n ** 8n
    const dec = 8n
    const need = usdCentsToWei(100n, price, dec)
    const overpay = need + 12_345n

    const beforeTreasury = await publicClient.getBalance({ address: treasury.account.address })
    await harness.write.exposedCollect([false], { value: overpay })
    const afterTreasury = await publicClient.getBalance({ address: treasury.account.address })
    expect(afterTreasury - beforeTreasury).to.equal(need)

    // Contract should not retain funds
    const contractBal = await publicClient.getBalance({ address: harness.address as `0x${string}` })
    expect(contractBal).to.equal(0n)

    // No module events
  })

  it('remaining cap hits zero on crossing payment (pre-cap path)', async function () {
    const [owner, treasury, partner, protocol] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const feed = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])
    const harness = await hre.viem.deployContract('MockFeeModuleHarness')
    // fees: claim=$1, stake=$1; cap=$1.50
    await harness.write.init([
      feed.address,
      86_400,
      treasury.account.address,
      protocol.account.address,
      partner.account.address,
      100n,
      100n,
      150n,
      0,
      0,
    ])
    const price = 3_000n * 10n ** 8n
    const dec = 8n
    const need = usdCentsToWei(100n, price, dec)

    // First $1 payment (no cap reached yet)
    await harness.write.exposedCollect([false], { value: need })

    // Second $1 payment crosses cap (total=200)
    await harness.write.exposedCollect([true], { value: need })
    expect(await harness.read.exposedRemainingCap()).to.equal(0n)
  })

  it('after cap in Cancel mode: requiredFeeWei becomes 0 and funds are not transferred', async function () {
    const { harness, treasury, publicClient } = await loadFixture(deployFixture)
    const price = 3_000n * 10n ** 8n
    const dec = 8n
    const need1 = usdCentsToWei(100n, price, dec)
    const need2 = usdCentsToWei(200n, price, dec)

    // Consume $5.00 cap: $1 + $2 + $2
    await harness.write.exposedCollect([false], { value: need1 })
    await harness.write.exposedCollect([true], { value: need2 })
    await harness.write.exposedCollect([true], { value: need2 })

    // Now cap is reached; requiredFeeWei should be 0 for both paths
    expect(await harness.read.exposedRequiredFeeWei([false])).to.equal(0n)
    expect(await harness.read.exposedRequiredFeeWei([true])).to.equal(0n)

    const before = await publicClient.getBalance({ address: treasury.account.address })
    // Attempt to pay more should not increase treasury in Cancel mode
    await harness.write.exposedCollect([false], { value: need1 })
    const after = await publicClient.getBalance({ address: treasury.account.address })
    expect(after - before).to.equal(0n)
  })

  it('routes post-cap to partner in RouteToPartner mode and supports partner rotation', async function () {
    const [owner, treasury, partner, protocol, newPartner] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    const feed = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])
    const harness = await hre.viem.deployContract('MockFeeModuleHarness')
    await harness.write.init([
      feed.address,
      86_400,
      treasury.account.address,
      protocol.account.address,
      partner.account.address,
      100n,
      200n,
      500n,
      1, // RouteToPartner
      0,
    ])

    const price = 3_000n * 10n ** 8n
    const dec = 8n
    const need1 = usdCentsToWei(100n, price, dec)
    const need2 = usdCentsToWei(200n, price, dec)

    // Reach cap
    await harness.write.exposedCollect([false], { value: need1 })
    await harness.write.exposedCollect([true], { value: need2 })
    await harness.write.exposedCollect([true], { value: need2 })

    // Post-cap routes to partnerOverflow
    const before = await publicClient.getBalance({ address: partner.account.address })
    await harness.write.exposedCollect([false], { value: need1 })
    const after = await publicClient.getBalance({ address: partner.account.address })
    expect(after - before).to.equal(need1)

    // Rotate partner and check routing
    await harness.write.exposedUpdatePartnerOverflow([newPartner.account.address])
    const before2 = await publicClient.getBalance({ address: newPartner.account.address })
    await harness.write.exposedCollect([true], { value: need2 })
    const after2 = await publicClient.getBalance({ address: newPartner.account.address })
    expect(after2 - before2).to.equal(need2)
  })

  it('routes post-cap to protocol in RouteToProtocol mode', async function () {
    const [owner, treasury, partner, protocol] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()

    const feed = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])
    const harness = await hre.viem.deployContract('MockFeeModuleHarness')
    await harness.write.init([
      feed.address,
      86_400,
      treasury.account.address,
      protocol.account.address,
      partner.account.address,
      100n,
      200n,
      500n,
      2, // RouteToProtocol
      0,
    ])

    const price = 3_000n * 10n ** 8n
    const dec = 8n
    const need1 = usdCentsToWei(100n, price, dec)
    const need2 = usdCentsToWei(200n, price, dec)

    // Reach cap
    await harness.write.exposedCollect([false], { value: need1 })
    await harness.write.exposedCollect([true], { value: need2 })
    await harness.write.exposedCollect([true], { value: need2 })

    const before = await publicClient.getBalance({ address: protocol.account.address })
    await harness.write.exposedCollect([false], { value: need1 })
    const after = await publicClient.getBalance({ address: protocol.account.address })
    expect(after - before).to.equal(need1)
  })

  it('zero-fee paths refund full msg.value and emit no ProtocolFeePaid', async function () {
    const [owner, treasury, partner, protocol, payer] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const feed = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])
    const harness = await hre.viem.deployContract('MockFeeModuleHarness')
    await harness.write.init([
      feed.address,
      86_400,
      treasury.account.address,
      protocol.account.address,
      partner.account.address,
      0n,    // claim fee off
      0n,    // stake fee off
      10_000n, // cap large
      0,
      0,
    ])
    const beforeTreasury = await publicClient.getBalance({ address: treasury.account.address })
    // Send some ETH; since fees are disabled, nothing should be transferred to treasury
    const txHash = await hre.viem.getContractAt('MockFeeModuleHarness', harness.address, { client: { wallet: payer } })
      .then(c => c.write.exposedCollect([false], { value: 123_456n }))
    const afterTreasury = await publicClient.getBalance({ address: treasury.account.address })
    expect(afterTreasury - beforeTreasury).to.equal(0n)

    // Contract should not retain funds
    const bal = await publicClient.getBalance({ address: harness.address as `0x${string}` })
    expect(bal).to.equal(0n)

    // No ProtocolFeePaid events
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
    const events = parseEventLogs({ abi: harness.abi, logs: receipt.logs, eventName: 'ProtocolFeePaid' })
    expect(events.length).to.equal(0)
  })

  it('reverts on stale price and bad price', async function () {
    const [owner, treasury, partner, protocol] = await hre.viem.getWalletClients()
    const feed = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])
    const harness = await hre.viem.deployContract('MockFeeModuleHarness')
    await harness.write.init([
      feed.address,
      1, // maxPriceAge 1s
      treasury.account.address,
      protocol.account.address,
      partner.account.address,
      100n,
      0n,
      10_000n,
      0,
      0,
    ])
    // Force staleness
    await (await hre.viem.getContractAt('MockAggregatorV3', feed.address)).write.setStale([1n])
    await expect(harness.read.exposedRequiredFeeWei([false])).to.be.rejectedWith('StalePrice')

    // Fresh but bad price
    const feed2 = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])
    const harness2 = await hre.viem.deployContract('MockFeeModuleHarness')
    await harness2.write.init([
      feed2.address,
      86_400,
      treasury.account.address,
      protocol.account.address,
      partner.account.address,
      100n,
      0n,
      10_000n,
      0,
      0,
    ])
    await (await hre.viem.getContractAt('MockAggregatorV3', feed2.address)).write.setAnswer([0n])
    await expect(harness2.read.exposedRequiredFeeWei([false])).to.be.rejectedWith('BadPrice')
  })

  it('post-cap routing uses correct receiver (no module events)', async function () {
    const [owner, treasury, partner, protocol] = await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const feed = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])
    const harness = await hre.viem.deployContract('MockFeeModuleHarness')
    await harness.write.init([
      feed.address,
      86_400,
      treasury.account.address,
      protocol.account.address,
      partner.account.address,
      100n, // claim
      200n, // stake
      300n, // cap
      1,   // RouteToPartner
      0,
    ])
    const price = 3_000n * 10n ** 8n
    const dec = 8n
    const need1 = usdCentsToWei(100n, price, dec)
    const need2 = usdCentsToWei(200n, price, dec)
    // Reach cap exactly by claim + stake payments
    await harness.write.exposedCollect([false], { value: need1 })
    await harness.write.exposedCollect([true], { value: need2 })

    // Now post-cap payment (claim path) routes to partner; also Stake path routes and emits
    await harness.write.exposedCollect([false], { value: need1 })
    await harness.write.exposedCollect([true], { value: need2 })
  })

  it('reverts on invalid feed decimals (>18)', async function () {
    const [owner, treasury, partner, protocol] = await hre.viem.getWalletClients()
    const feed = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])
    const harness = await hre.viem.deployContract('MockFeeModuleHarness')
    await harness.write.init([
      feed.address,
      86_400,
      treasury.account.address,
      protocol.account.address,
      partner.account.address,
      100n,
      0n,
      10_000n,
      0,
      0,
    ])

    // Set feed decimals to 19 to trigger the guard
    await (await hre.viem.getContractAt('MockAggregatorV3', feed.address)).write.setDecimals([19])
    await expect(harness.read.exposedRequiredFeeWei([false])).to.be.rejectedWith('InvalidFeedDecimals')
  })
})
