import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import {
  getAddress,
  keccak256,
  encodePacked,
  zeroAddress,
} from 'viem'

enum OverflowMode {
  Cancel = 0,
  RouteToPartner = 1,
  RouteToProtocol = 2,
}

type Address = `0x${string}`

describe('Factory: signed deployment, roles, fees (mocks)', function () {
  async function deployFixture() {
    const [protocolAdmin, protocolSigner, expectedDeployer, other] =
      await hre.viem.getWalletClients()
    const publicClient = await hre.viem.getPublicClient()
    const chainId = await publicClient.getChainId()

    // Mock feed: 8 decimals, price ~ 3000 * 10^8
    const feed = await hre.viem.deployContract('MockAggregatorV3', [8, 3_000n * 10n ** 8n])

    // Mock ERC20 and mint to admin
    const erc20 = await hre.viem.deployContract('MockERC20', [
      protocolAdmin.account.address,
    ])

    // MockStake implements IBaseStake
    const mockStake = await hre.viem.deployContract('MockStake')

    // Factory with initial protocol admin
    const factory = await hre.viem.deployContract('SnagAirdropV2Factory', [
      protocolAdmin.account.address,
    ])

    // Grant signer
    const factoryAsAdmin = await hre.viem.getContractAt(
      'SnagAirdropV2Factory',
      factory.address,
      { client: { wallet: protocolAdmin } },
    )
    await factoryAsAdmin.write.grantProtocolSigner([protocolSigner.account.address])

    return {
      protocolAdmin,
      protocolSigner,
      expectedDeployer,
      other,
      publicClient,
      chainId: BigInt(chainId),
      factory,
      factoryAsAdmin,
      feed,
      erc20,
      mockStake,
    }
  }

  // ---------------- EIP-712 helpers ----------------

  function eip712Domain(factory: Address, chainId: bigint) {
    return {
      name: 'SnagAirdropV2Factory',
      version: '1',
      chainId,
      verifyingContract: factory,
    } as const
  }

  const CreateTypes = {
    CreateAirdrop: [
      { name: 'factory', type: 'address' },
      { name: 'expectedDeployer', type: 'address' },
      { name: 'deadline', type: 'uint256' },

      { name: 'salt', type: 'bytes32' },
      { name: 'admin', type: 'address' },
      { name: 'root', type: 'bytes32' },
      { name: 'token', type: 'address' },
      { name: 'staking', type: 'address' },
      { name: 'maxBonus', type: 'uint256' },
      { name: 'minLockup', type: 'uint32' },
      { name: 'minLockupForMultiplier', type: 'uint32' },
      { name: 'multiplier', type: 'uint256' },

      { name: 'feeClaimUsdCents', type: 'uint64' },
      { name: 'feeStakeUsdCents', type: 'uint64' },
      { name: 'feeCapUsdCents', type: 'uint64' },

      { name: 'priceFeed', type: 'address' },
      { name: 'maxPriceAge', type: 'uint32' },
      { name: 'protocolTreasury', type: 'address' },
      { name: 'protocolOverflow', type: 'address' },
      { name: 'partnerOverflow', type: 'address' },
      { name: 'overflowMode', type: 'uint8' },
      { name: 'protocolTokenShareBips', type: 'uint16' },

      { name: 'deploymentFeeUsdCents', type: 'uint64' },
    ] as const,
  }

  function buildCreatePayload(args: {
    factory: Address
    expectedDeployer: Address
    token: Address
    priceFeed: Address
    protocolTreasury: Address
    protocolOverflow: Address
    partnerOverflow: Address
    staking?: Address
    salt?: `0x${string}`
    root?: `0x${string}`
    maxBonus?: bigint
    minLockup?: number
    minLockupForMultiplier?: number
    multiplier?: bigint
    feeClaimUsdCents?: number
    feeStakeUsdCents?: number
    feeCapUsdCents?: number
    maxPriceAge?: number
    overflowMode?: OverflowMode
    protocolTokenShareBips?: number
    deploymentFeeUsdCents?: number
    deadline?: number
  }) {
    const now = Math.floor(Date.now() / 1000)
    const salt =
      args.salt ?? (keccak256(encodePacked(['string'], ['salt'])) as `0x${string}`)
    const root =
      args.root ?? (keccak256(encodePacked(['string'], ['root'])) as `0x${string}`)

    return {
      factory: args.factory,
      expectedDeployer: args.expectedDeployer,
      deadline: BigInt(args.deadline ?? now + 3600),

      salt,
      admin: args.expectedDeployer,
      root,
      token: args.token,
      staking: args.staking ?? zeroAddress,
      maxBonus: args.maxBonus ?? 0n,
      minLockup: args.minLockup ?? 0,
      minLockupForMultiplier: args.minLockupForMultiplier ?? 0,
      multiplier: args.multiplier ?? 0n,

      feeClaimUsdCents: args.feeClaimUsdCents ?? 30,
      feeStakeUsdCents: args.feeStakeUsdCents ?? 40,
      feeCapUsdCents: args.feeCapUsdCents ?? 2_000_000,
      priceFeed: args.priceFeed,
      maxPriceAge: args.maxPriceAge ?? 86_400,
      protocolTreasury: args.protocolTreasury,
      protocolOverflow: args.protocolOverflow,
      partnerOverflow: args.partnerOverflow,
      overflowMode: args.overflowMode ?? OverflowMode.Cancel,
      protocolTokenShareBips: args.protocolTokenShareBips ?? 100,
      deploymentFeeUsdCents: args.deploymentFeeUsdCents ?? 0,
    }
  }

  function toCreateParams(m: any) {
    return {
      salt: m.salt,
      admin: m.admin,
      root: m.root,
      token: m.token,
      staking: m.staking,
      maxBonus: m.maxBonus,
      minLockup: m.minLockup,
      minLockupForMultiplier: m.minLockupForMultiplier,
      multiplier: m.multiplier,
    }
  }
  function toFeeConfig(m: any) {
    return {
      feeClaimUsdCents: m.feeClaimUsdCents,
      feeStakeUsdCents: m.feeStakeUsdCents,
      feeCapUsdCents: m.feeCapUsdCents,
      priceFeed: m.priceFeed,
      maxPriceAge: m.maxPriceAge,
      protocolTreasury: m.protocolTreasury,
      protocolOverflow: m.protocolOverflow,
      partnerOverflow: m.partnerOverflow,
      overflowMode: m.overflowMode,
      protocolTokenShareBips: m.protocolTokenShareBips,
    }
  }

  // ---------------- Tests ----------------

  it('role management: protocol admin can grant/revoke signer', async function () {
    const { factory, protocolAdmin, other } = await loadFixture(deployFixture)

    const asAdmin = await hre.viem.getContractAt(
      'SnagAirdropV2Factory',
      factory.address,
      { client: { wallet: protocolAdmin } },
    )
    const asOther = await hre.viem.getContractAt(
      'SnagAirdropV2Factory',
      factory.address,
      { client: { wallet: other } },
    )

    await expect(asAdmin.write.grantProtocolSigner([other.account.address])).to
      .not.be.rejected
    await expect(asAdmin.write.revokeProtocolSigner([other.account.address])).to
      .not.be.rejected

    await expect(
      asOther.write.grantProtocolSigner([protocolAdmin.account.address]),
    ).to.be.rejected
  })

  it('deploys with valid signature (MockERC20 + MockStake)', async function () {
    const { factory, protocolSigner, expectedDeployer, feed, erc20, mockStake, chainId } =
      await loadFixture(deployFixture)

    const message = buildCreatePayload({
      factory: getAddress(factory.address),
      expectedDeployer: getAddress(expectedDeployer.account.address),
      token: getAddress(erc20.address),
      priceFeed: getAddress(feed.address),
      protocolTreasury: getAddress(expectedDeployer.account.address),
      protocolOverflow: getAddress(expectedDeployer.account.address),
      partnerOverflow: getAddress(expectedDeployer.account.address),
      staking: getAddress(mockStake.address),
      deploymentFeeUsdCents: 0,
    })

    const signature = await protocolSigner.signTypedData({
      account: protocolSigner.account,
      domain: eip712Domain(getAddress(factory.address), chainId),
      types: CreateTypes,
      primaryType: 'CreateAirdrop',
      message,
    })

    const asDeployer = await hre.viem.getContractAt(
      'SnagAirdropV2Factory',
      factory.address,
      { client: { wallet: expectedDeployer } },
    )
    await expect(
      asDeployer.write.createAirdropSigned([
        toCreateParams(message),
        toFeeConfig(message),
        message.deploymentFeeUsdCents,
        message.expectedDeployer,
        message.deadline,
        signature,
      ]),
    ).to.not.be.rejected

    const id = keccak256(
      encodePacked(['address', 'bytes32'], [message.expectedDeployer, message.salt]),
    )
    const claimAddr = await factory.read.airdropContracts([id])
    expect(getAddress(claimAddr)).to.not.equal(zeroAddress)

    const claim = await hre.viem.getContractAt('SnagAirdropV2Claim', claimAddr)
    expect(await claim.read.root()).to.equal(message.root)
    expect(await claim.read.isActive()).to.equal(true)
    expect(getAddress(await claim.read.factory())).to.equal(
      getAddress(factory.address),
    )
    // staking matches MockStake
    expect(getAddress(await claim.read.stakingAddress())).to.equal(
      getAddress(mockStake.address),
    )
  })

  it('reverts with InvalidSigner if signature not from protocol signer', async function () {
    const { factory, other, expectedDeployer, feed, erc20, chainId } =
      await loadFixture(deployFixture)

    const message = buildCreatePayload({
      factory: getAddress(factory.address),
      expectedDeployer: getAddress(expectedDeployer.account.address),
      token: getAddress(erc20.address),
      priceFeed: getAddress(feed.address),
      protocolTreasury: getAddress(expectedDeployer.account.address),
      protocolOverflow: getAddress(expectedDeployer.account.address),
      partnerOverflow: getAddress(expectedDeployer.account.address),
    })

    const badSig = await other.signTypedData({
      account: other.account,
      domain: eip712Domain(getAddress(factory.address), chainId),
      types: CreateTypes,
      primaryType: 'CreateAirdrop',
      message,
    })

    const asDeployer = await hre.viem.getContractAt(
      'SnagAirdropV2Factory',
      factory.address,
      { client: { wallet: expectedDeployer } },
    )

    await expect(
      asDeployer.write.createAirdropSigned([
        toCreateParams(message),
        toFeeConfig(message),
        message.deploymentFeeUsdCents,
        message.expectedDeployer,
        message.deadline,
        badSig,
      ]),
    ).to.be.rejectedWith('InvalidSigner')
  })

  it('reverts with UnexpectedDeployer if caller != expectedDeployer', async function () {
    const { factory, protocolSigner, other, expectedDeployer, feed, erc20, chainId } =
      await loadFixture(deployFixture)

    const message = buildCreatePayload({
      factory: getAddress(factory.address),
      expectedDeployer: getAddress(expectedDeployer.account.address),
      token: getAddress(erc20.address),
      priceFeed: getAddress(feed.address),
      protocolTreasury: getAddress(expectedDeployer.account.address),
      protocolOverflow: getAddress(expectedDeployer.account.address),
      partnerOverflow: getAddress(expectedDeployer.account.address),
    })

    const sig = await protocolSigner.signTypedData({
      account: protocolSigner.account,
      domain: eip712Domain(getAddress(factory.address), chainId),
      types: CreateTypes,
      primaryType: 'CreateAirdrop',
      message,
    })

    const asOther = await hre.viem.getContractAt(
      'SnagAirdropV2Factory',
      factory.address,
      { client: { wallet: other } },
    )

    await expect(
      asOther.write.createAirdropSigned([
        toCreateParams(message),
        toFeeConfig(message),
        message.deploymentFeeUsdCents,
        message.expectedDeployer,
        message.deadline,
        sig,
      ]),
    ).to.be.rejectedWith('UnexpectedDeployer')
  })

  it('reverts with Expired if past deadline', async function () {
    const { factory, protocolSigner, expectedDeployer, feed, erc20, publicClient } =
      await loadFixture(deployFixture)

    const currentTs = Number((await publicClient.getBlock()).timestamp)
    const message = buildCreatePayload({
      factory: getAddress(factory.address),
      expectedDeployer: getAddress(expectedDeployer.account.address),
      token: getAddress(erc20.address),
      priceFeed: getAddress(feed.address),
      protocolTreasury: getAddress(expectedDeployer.account.address),
      protocolOverflow: getAddress(expectedDeployer.account.address),
      partnerOverflow: getAddress(expectedDeployer.account.address),
      // Use chain time to ensure it is truly expired on this provider
      deadline: currentTs - 10,
    })

    const sig = await protocolSigner.signTypedData({
      account: protocolSigner.account,
      domain: eip712Domain(getAddress(factory.address)),
      types: CreateTypes,
      primaryType: 'CreateAirdrop',
      message,
    })

    const asDeployer = await hre.viem.getContractAt(
      'SnagAirdropV2Factory',
      factory.address,
      { client: { wallet: expectedDeployer } },
    )

    await expect(
      asDeployer.write.createAirdropSigned([
        toCreateParams(message),
        toFeeConfig(message),
        message.deploymentFeeUsdCents,
        message.expectedDeployer,
        message.deadline,
        sig,
      ]),
    ).to.be.rejectedWith('Expired')
  })

  it('deployment fee: preview/collect/underpay/overpay', async function () {
    const {
      factory,
      protocolSigner,
      expectedDeployer,
      other,
      feed,
      erc20,
      publicClient,
      chainId,
    } = await loadFixture(deployFixture)

    const treasury = getAddress(other.account.address)
    const message = buildCreatePayload({
      factory: getAddress(factory.address),
      expectedDeployer: getAddress(expectedDeployer.account.address),
      token: getAddress(erc20.address),
      priceFeed: getAddress(feed.address),
      protocolTreasury: treasury,
      protocolOverflow: treasury,
      partnerOverflow: treasury,
      deploymentFeeUsdCents: 12_345, // $123.45
      feeClaimUsdCents: 0,
      feeStakeUsdCents: 0,
      feeCapUsdCents: 0,
      protocolTokenShareBips: 0,
    })

    const need = await factory.read.previewDeploymentFeeWei([
      toFeeConfig(message),
      message.deploymentFeeUsdCents,
    ])
    expect(need).to.not.equal(0n)

    const sig = await protocolSigner.signTypedData({
      account: protocolSigner.account,
      domain: eip712Domain(getAddress(factory.address), chainId),
      types: CreateTypes,
      primaryType: 'CreateAirdrop',
      message,
    })

    const asDeployer = await hre.viem.getContractAt(
      'SnagAirdropV2Factory',
      factory.address,
      { client: { wallet: expectedDeployer } },
    )

    // underpay
    await expect(
      asDeployer.write.createAirdropSigned(
        [
          toCreateParams(message),
          toFeeConfig(message),
          message.deploymentFeeUsdCents,
          message.expectedDeployer,
          message.deadline,
          sig,
        ],
        { value: need - 1n },
      ),
    ).to.be.rejectedWith('InsufficientDeploymentFee')

    // exact pay
    const beforeTreasury = await publicClient.getBalance({ address: treasury })
    await asDeployer.write.createAirdropSigned(
      [
        toCreateParams(message),
        toFeeConfig(message),
        message.deploymentFeeUsdCents,
        message.expectedDeployer,
        message.deadline,
        sig,
      ],
      { value: need },
    )
    const afterTreasury = await publicClient.getBalance({ address: treasury })
    expect(afterTreasury - beforeTreasury).to.equal(need)

    // overpay (refund)
    const message2 = { ...message, salt: keccak256(encodePacked(['string'], ['salt2'])) as `0x${string}` }
    const sig2 = await protocolSigner.signTypedData({
      account: protocolSigner.account,
      domain: eip712Domain(getAddress(factory.address), chainId),
      types: CreateTypes,
      primaryType: 'CreateAirdrop',
      message: message2,
    })
    await expect(
      asDeployer.write.createAirdropSigned(
        [
          toCreateParams(message2),
          toFeeConfig(message2),
          message2.deploymentFeeUsdCents,
          message2.expectedDeployer,
          message2.deadline,
          sig2,
        ],
        { value: need + 10_000n },
      ),
    ).to.not.be.rejected
    // refund correctness is gas-dependent; we assert treasury delta only in exact pay above
  })

  it('rejects non-IBaseStake staking contract', async function () {
    const { factory, protocolSigner, expectedDeployer, feed, erc20, chainId } =
      await loadFixture(deployFixture)

    // Try using ERC20 address as staking (does not support IBaseStake)
    const message = buildCreatePayload({
      factory: getAddress(factory.address),
      expectedDeployer: getAddress(expectedDeployer.account.address),
      token: getAddress(erc20.address),
      priceFeed: getAddress(feed.address),
      protocolTreasury: getAddress(expectedDeployer.account.address),
      protocolOverflow: getAddress(expectedDeployer.account.address),
      partnerOverflow: getAddress(expectedDeployer.account.address),
      staking: getAddress(erc20.address),
    })

    const sig = await protocolSigner.signTypedData({
      account: protocolSigner.account,
      domain: eip712Domain(getAddress(factory.address), chainId),
      types: CreateTypes,
      primaryType: 'CreateAirdrop',
      message,
    })

    const asDeployer = await hre.viem.getContractAt(
      'SnagAirdropV2Factory',
      factory.address,
      { client: { wallet: expectedDeployer } },
    )

    await expect(
      asDeployer.write.createAirdropSigned([
        toCreateParams(message),
        toFeeConfig(message),
        message.deploymentFeeUsdCents,
        message.expectedDeployer,
        message.deadline,
        sig,
      ]),
    ).to.be.rejectedWith('InvalidStakingContract')
  })
})
