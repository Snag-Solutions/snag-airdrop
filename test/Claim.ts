import {
  time,
  loadFixture,
} from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { getAddress, parseGwei, parseEther, keccak256, zeroAddress, maxUint256 } from 'viem'
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import {
  CLAIM_OPTIONS,
  deployClaimContract,
  deployClaimContractWithMultiplier,
  deployClaimContractWithCustomBalance,
  setupClaimTest,
  executeClaim,
  verifyClaimStakingData,
  getClaimData,
  getClaimStakingData,
  getClaimStakingAddress,
} from './helpers/claim'
import {
  deployFixture,
  verifyUserBalance,
  createRandomId,
  findUserInClaimList,
  getMerkleProof,
} from './helpers/shared'
import { makeClaimArgs } from './helpers/makeClaimArgs'

describe('Claim', function () {
  // ───────────── Admin Tests ─────────────────────────────────────

  describe('Admin Flows', function () {
    it('should deploy a claim contract', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { contractAddress } = await deployClaimContract(
        router,
        root,
        erc20,
        owner
      )
      expect(contractAddress).to.not.equal(null)
    })

    it('Should cancel a claim contract', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { id, contractAddress } = await deployClaimContract(
        router,
        root,
        erc20,
        owner
      )

      const claimContractBalance = await erc20.read.balanceOf([contractAddress])
      const ownerBalance = await erc20.read.balanceOf([owner.account.address])

      await router.write.endAirdrop([id, owner.account.address])

      const claimContractBalance2 = await erc20.read.balanceOf([
        contractAddress,
      ])
      const ownerBalance2 = await erc20.read.balanceOf([owner.account.address])

      expect(claimContractBalance2).to.equal(0n)
      expect(ownerBalance2).to.equal(claimContractBalance + ownerBalance)
    })

    it('Should Update Multiplier on claim contract', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { id, contractAddress } = await deployClaimContract(
        router,
        root,
        erc20,
        owner
      )

      const claimContract = await hre.viem.getContractAt(
        'SnagAirdropClaim',
        contractAddress
      )
      const multiplier = await claimContract.read.multiplier()

      await router.write.setMultiplier([id, 100n])

      const multiplier2 = await claimContract.read.multiplier()
      expect(multiplier2).to.not.equal(multiplier)
    })
  })

  // ───────────── User Claim Tests ─────────────────────────────────

  describe('User Claim Flows', function () {
    it('Should claim tokens with full claim option', async function () {
      const {
        routerAsClaimList,
        inClaimList,
        id,
        erc20,
        proof,
        totalAllocation,
      } = await setupClaimTest()

      await executeClaim(
        routerAsClaimList,
        inClaimList,
        id,
        proof,
        totalAllocation,
        CLAIM_OPTIONS.FULL_CLAIM
      )
      await verifyUserBalance(
        erc20,
        inClaimList.account.address,
        totalAllocation
      )
    })

    it('Should claim and stake tokens with half-half option', async function () {
      const {
        routerAsClaimList,
        inClaimList,
        id,
        erc20,
        proof,
        totalAllocation,
      } = await setupClaimTest()

      await executeClaim(
        routerAsClaimList,
        inClaimList,
        id,
        proof,
        totalAllocation,
        CLAIM_OPTIONS.HALF_CLAIM_HALF_STAKE
      )

      // Verify claimed amount (50%)
      await verifyUserBalance(
        erc20,
        inClaimList.account.address,
        totalAllocation / 2n
      )

      // Verify staking data
      await verifyClaimStakingData(
        routerAsClaimList,
        id,
        inClaimList.account.address,
        1
      )
    })

    it('Should claim tokens with partial claim option', async function () {
      const {
        routerAsClaimList,
        inClaimList,
        id,
        erc20,
        proof,
        totalAllocation,
      } = await setupClaimTest()

      // First claim - should succeed
      await executeClaim(
        routerAsClaimList,
        inClaimList,
        id,
        proof,
        totalAllocation,
        CLAIM_OPTIONS.PARTIAL_CLAIM
      )
      await verifyUserBalance(
        erc20,
        inClaimList.account.address,
        totalAllocation / 2n
      )

      // Try to claim again - should fail
      await expect(
        executeClaim(
          routerAsClaimList,
          inClaimList,
          id,
          proof,
          totalAllocation,
          CLAIM_OPTIONS.PARTIAL_CLAIM
        )
      ).to.be.rejectedWith('AlreadyClaimed')

      // Verify balance hasn't changed
      await verifyUserBalance(
        erc20,
        inClaimList.account.address,
        totalAllocation / 2n
      )
    })

    it('Should reject claim with incorrect signature', async function () {
      const {
        router,
        owner,
        root,
        erc20,
        inClaimList,
        otherAccount,
        tree,
        claimList,
      } = await deployFixture()
      const { id } = await deployClaimContract(router, root, erc20, owner)

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Create signature with wrong signer (otherAccount instead of inClaimList)
      const args = await makeClaimArgs(
        inClaimList, // Wrong signer - should be inClaimList
        {
          id,
          proof,
          totalAllocation,
          opts: CLAIM_OPTIONS.FULL_CLAIM,
        },
        await routerAsClaimList.read.claimContractById([id])
      )

      // Should fail because signature doesn't match the beneficiary
      await expect(
        routerAsClaimList.write.claim([
          args[0],
          otherAccount.account.address,
          args[2],
          args[3],
          args[4],
          args[5],
        ])
      ).to.be.rejectedWith('InvalidSignature')

      // Verify no tokens were claimed
      await verifyUserBalance(erc20, inClaimList.account.address, 0n)
    })
  })

  // ───────────── Multiplier Tests ─────────────────────────────────

  describe('Multiplier Logic', function () {
    it('Should apply multiplier when lockup period meets threshold', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()

      // Deploy with multiplier and threshold
      const multiplier = 1000n // 10% bonus (1000 bips)
      const minLockupDuration = 30 // 30 seconds
      const minLockupDurationForMultiplier = 60 // 60 seconds for bonus

      const { id } = await deployClaimContractWithMultiplier(
        router,
        root,
        erc20,
        owner,
        multiplier,
        true, // with staking
        zeroAddress, // use default staking
        minLockupDuration,
        minLockupDurationForMultiplier
      )

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Create claim options with lockup period that meets multiplier threshold
      const claimOptions = {
        percentageToClaim: 0,
        percentageToStake: 10_000, // 100% staked (in bips)
        lockupPeriod: 120, // 120 seconds > 60 second threshold
        optionId: keccak256(new TextEncoder().encode('test-option')),
      }

      const args = await makeClaimArgs(
        inClaimList,
        {
          id,
          proof,
          totalAllocation,
          opts: claimOptions,
        },
        await routerAsClaimList.read.claimContractById([id]),
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts
      const expectedStaked = totalAllocation // 100% staked
      const expectedBonus = (expectedStaked * multiplier) / 10000n // 10% bonus
      const expectedTotalStaked = expectedStaked + expectedBonus

      // Verify staking data shows the bonus tokens were staked
      await verifyClaimStakingData(
        routerAsClaimList,
        id,
        inClaimList.account.address,
        1
      )

      // Get claim data to verify bonus was applied
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })

    it('Should NOT apply multiplier when lockup period below threshold', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()

      // Deploy with multiplier and threshold
      const multiplier = 1000n // 10% bonus
      const minLockupDuration = 30
      const minLockupDurationForMultiplier = 60 // 60 seconds for bonus

      const { id } = await deployClaimContractWithMultiplier(
        router,
        root,
        erc20,
        owner,
        multiplier,
        true,
        zeroAddress,
        minLockupDuration,
        minLockupDurationForMultiplier
      )

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Create claim options with lockup period BELOW multiplier threshold
      const claimOptions = {
        percentageToClaim: 0,
        percentageToStake: 10_000, // 100% staked (in bips)
        lockupPeriod: 45, // 45 seconds < 60 second threshold
        optionId: keccak256(new TextEncoder().encode('test-option')),
      }

      const args = await makeClaimArgs(
        inClaimList,
        {
          id,
          proof,
          totalAllocation,
          opts: claimOptions,
        },
        await routerAsClaimList.read.claimContractById([id]),
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts (no bonus)
      const expectedStaked = totalAllocation
      const expectedBonus = 0n

      // Verify staking data
      await verifyClaimStakingData(
        routerAsClaimList,
        id,
        inClaimList.account.address,
        1
      )

      // Get claim data to verify NO bonus was applied
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })

    it('Should NOT apply multiplier when multiplier is zero', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()

      // Deploy with ZERO multiplier
      const multiplier = 0n // No bonus
      const minLockupDuration = 30
      const minLockupDurationForMultiplier = 60

      const { id } = await deployClaimContractWithMultiplier(
        router,
        root,
        erc20,
        owner,
        multiplier,
        true,
        zeroAddress,
        minLockupDuration,
        minLockupDurationForMultiplier
      )

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Create claim options with lockup period that would normally qualify
      const claimOptions = {
        percentageToClaim: 0,
        percentageToStake: 10_000, // 100% staked (in bips)
        lockupPeriod: 120, // > threshold
        optionId: keccak256(new TextEncoder().encode('test-option')),
      }

      const args = await makeClaimArgs(
        inClaimList,
        {
          id,
          proof,
          totalAllocation,
          opts: claimOptions,
        },
        await routerAsClaimList.read.claimContractById([id]),
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts (no bonus because multiplier is 0)
      const expectedStaked = totalAllocation
      const expectedBonus = 0n

      // Verify staking data
      await verifyClaimStakingData(
        routerAsClaimList,
        id,
        inClaimList.account.address,
        1
      )

      // Get claim data to verify NO bonus was applied
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })

    it('Should apply multiplier to partial stake amounts', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()

      // Deploy with multiplier
      const multiplier = 2000n // 20% bonus
      const minLockupDuration = 30
      const minLockupDurationForMultiplier = 60

      const { id } = await deployClaimContractWithMultiplier(
        router,
        root,
        erc20,
        owner,
        multiplier,
        true,
        zeroAddress,
        minLockupDuration,
        minLockupDurationForMultiplier
      )

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Create claim options with partial stake
      const claimOptions = {
        percentageToClaim: 3_000, // 30% claimed (in bips)
        percentageToStake: 7_000, // 70% staked (in bips)
        lockupPeriod: 120, // > threshold
        optionId: keccak256(new TextEncoder().encode('test-option')),
      }

      const args = await makeClaimArgs(
        inClaimList,
        {
          id,
          proof,
          totalAllocation,
          opts: claimOptions,
        },
        await routerAsClaimList.read.claimContractById([id]),
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts
      const expectedClaimed = (totalAllocation * 3_000n) / 10_000n
      const expectedStaked = (totalAllocation * 7_000n) / 10_000n
      const expectedBonus = (expectedStaked * multiplier) / 10000n // 20% bonus on staked amount
      const expectedTotalStaked = expectedStaked + expectedBonus

      // Verify user received claimed amount
      await verifyUserBalance(
        erc20,
        inClaimList.account.address,
        expectedClaimed
      )

      // Verify staking data
      await verifyClaimStakingData(
        routerAsClaimList,
        id,
        inClaimList.account.address,
        1
      )

      // Get claim data to verify bonus was applied correctly
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )
      expect(claimData.totalClaimed).to.equal(expectedClaimed)
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })

    it('Should handle multiplier update after deployment', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()

      // Deploy with initial multiplier
      const initialMultiplier = 500n // 5% bonus
      const newMultiplier = 1500n // 15% bonus
      const minLockupDuration = 30
      const minLockupDurationForMultiplier = 60

      const { id } = await deployClaimContractWithMultiplier(
        router,
        root,
        erc20,
        owner,
        initialMultiplier,
        true,
        zeroAddress,
        minLockupDuration,
        minLockupDurationForMultiplier
      )

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Update multiplier before claiming
      await router.write.setMultiplier([id, newMultiplier])

      // Create claim options
      const claimOptions = {
        percentageToClaim: 0,
        percentageToStake: 10_000, // 100% staked (in bips)
        lockupPeriod: 120, // > threshold
        optionId: keccak256(new TextEncoder().encode('test-option')),
      }

      const args = await makeClaimArgs(
        inClaimList,
        {
          id,
          proof,
          totalAllocation,
          opts: claimOptions,
        },
        await routerAsClaimList.read.claimContractById([id]),
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts with NEW multiplier
      const expectedStaked = totalAllocation
      const expectedBonus = (expectedStaked * newMultiplier) / 10000n // 15% bonus

      // Verify staking data
      await verifyClaimStakingData(
        routerAsClaimList,
        id,
        inClaimList.account.address,
        1
      )

      // Get claim data to verify NEW multiplier was applied
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(newMultiplier)
    })

    it('Should handle edge case: exact threshold lockup period', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()

      // Deploy with multiplier
      const multiplier = 1000n // 10% bonus
      const minLockupDuration = 30
      const minLockupDurationForMultiplier = 60

      const { id } = await deployClaimContractWithMultiplier(
        router,
        root,
        erc20,
        owner,
        multiplier,
        true,
        zeroAddress,
        minLockupDuration,
        minLockupDurationForMultiplier
      )

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Create claim options with EXACT threshold lockup period
      const claimOptions = {
        percentageToClaim: 0,
        percentageToStake: 10_000, // 100% staked (in bips)
        lockupPeriod: 60, // Exactly equal to threshold
        optionId: keccak256(new TextEncoder().encode('test-option')),
      }

      const args = await makeClaimArgs(
        inClaimList,
        {
          id,
          proof,
          totalAllocation,
          opts: claimOptions,
        },
        await routerAsClaimList.read.claimContractById([id]),
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts (should get bonus because >= threshold)
      const expectedStaked = totalAllocation
      const expectedBonus = (expectedStaked * multiplier) / 10000n

      // Verify staking data
      await verifyClaimStakingData(
        routerAsClaimList,
        id,
        inClaimList.account.address,
        1
      )

      // Get claim data to verify bonus was applied
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })
  })

  // ───────────── Data Retrieval Tests ─────────────────────────────

  describe('Data Retrieval', function () {
    it('Should get staking data via router', async function () {
      const { routerAsClaimList, inClaimList, id, proof, totalAllocation } =
        await setupClaimTest()

      await executeClaim(
        routerAsClaimList,
        inClaimList,
        id,
        proof,
        totalAllocation,
        CLAIM_OPTIONS.HALF_CLAIM_HALF_STAKE
      )
      await verifyClaimStakingData(
        routerAsClaimList,
        id,
        inClaimList.account.address,
        1
      )
    })

    it('Should get claim data via router', async function () {
      const {
        routerAsClaimList,
        inClaimList,
        id,
        erc20,
        proof,
        totalAllocation,
      } = await setupClaimTest()

      await executeClaim(
        routerAsClaimList,
        inClaimList,
        id,
        proof,
        totalAllocation,
        CLAIM_OPTIONS.PARTIAL_CLAIM
      )

      // Get claim data for specific user
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )

      // Verify claim data
      expect(claimData.totalClaimed).to.equal(totalAllocation / 2n) // 50% claimed
      expect(claimData.claimedByUser).to.equal(totalAllocation / 2n)
      expect(claimData.totalStaked).to.equal(0n) // No staking in this test
      expect(claimData.totalBonusTokens).to.equal(0n)
      expect(claimData.minLockupDuration).to.equal(0)
      expect(claimData.minLockupDurationForMultiplier).to.equal(0)
      expect(claimData.multiplier).to.equal(0n)
      expect(claimData.isActive).to.equal(true)
      expect(claimData.isPaused).to.equal(false)
      expect(claimData.tokenAsset).to.equal(getAddress(erc20.address))
      expect(claimData.stakingAddress).to.not.equal(zeroAddress)
      expect(claimData.admin).to.not.equal(zeroAddress)

      // Get claim data for zero address (should return 0 for claimedByUser)
      const claimDataZeroAddress = await getClaimData(
        routerAsClaimList,
        id,
        zeroAddress
      )
      expect(claimDataZeroAddress.claimedByUser).to.equal(0n)
      expect(claimDataZeroAddress.totalClaimed).to.equal(totalAllocation / 2n)
    })

    it('Should get staking address via router', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { id } = await deployClaimContract(router, root, erc20, owner)

      const stakingAddress = await getClaimStakingAddress(router, id)
      expect(stakingAddress).to.not.equal(zeroAddress)

      // Verify it matches the staking address from getClaimData
      const claimData = await getClaimData(router, id, zeroAddress)
      expect(stakingAddress).to.equal(claimData.stakingAddress)
    })

    it('Should handle non-existent airdrop ID', async function () {
      const { router } = await deployFixture()
      const nonExistentId = createRandomId()

      // Should revert for non-existent ID
      await expect(
        getClaimData(router, nonExistentId, zeroAddress)
      ).to.be.rejectedWith('InvalidId')

      await expect(
        getClaimStakingData(router, nonExistentId, zeroAddress)
      ).to.be.rejectedWith('InvalidId')

      await expect(
        getClaimStakingAddress(router, nonExistentId)
      ).to.be.rejectedWith('InvalidId')
    })

    it('Should handle airdrop without staking', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { id } = await deployClaimContract(
        router,
        root,
        erc20,
        owner,
        false
      ) // no staking

      // Get claim data
      const claimData = await getClaimData(router, id, zeroAddress)
      expect(claimData.stakingAddress).to.equal(zeroAddress)

      // Get staking address should return zero address
      const stakingAddress = await getClaimStakingAddress(router, id)
      expect(stakingAddress).to.equal(zeroAddress)

      // Get staking data should return empty arrays
      await verifyClaimStakingData(router, id, owner.account.address, 0)
    })
  })

  // ───────────── OutOfTokens Error Tests ─────────────────────────────
  describe('OutOfTokens Error', function () {
    it('should revert with OutOfTokens if claim exceeds contract balance', async function () {
      // Setup: deploy with a claim list entry larger than the contract balance
      const { router, owner, erc20 } = await deployFixture()

      // Create a new merkle tree with a big user allocation
      const bigUser = (await hre.viem.getWalletClients())[4]
      const bigAllocation = parseEther('100')
      const claimList: [string, bigint][] = [
        [bigUser.account.address, bigAllocation],
      ]
      const tree = StandardMerkleTree.of(claimList, ['address', 'uint256'])
      const root = tree.root as `0x${string}`

      // Deploy claim contract with only 1 ETH in balance
      const { id, contractAddress } =
        await deployClaimContractWithCustomBalance(
          router,
          root,
          erc20,
          owner,
          0n, // no multiplier
          parseEther('1'), // only 1 ETH in contract
          true
        )

      // Create proper claim options and proof
      const claimOptions = {
        percentageToClaim: 10_000, // 100% claimed (in bips)
        percentageToStake: 0,
        lockupPeriod: 0,
        optionId: keccak256(new TextEncoder().encode('big-claim')),
      }
      const claimListEntry = findUserInClaimList(
        claimList,
        bigUser.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')
      const proof = getMerkleProof(tree, claimListEntry)

      const routerAsBigUser = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: bigUser } }
      )
      // Try to claim and expect OutOfTokens revert
      const args = await makeClaimArgs(
        bigUser,
        {
          id,
          proof,
          totalAllocation: bigAllocation,
          opts: claimOptions,
        },
        contractAddress,
      )
      await expect(routerAsBigUser.write.claim(args)).to.be.rejectedWith(
        'OutOfTokens'
      )
    })

    it('should revert with OutOfTokens if multiplier bonus causes contract to run out of tokens', async function () {
      // Setup: deploy with a super high multiplier
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()
      const superHighMultiplier = 100_000n // 1000% bonus
      // Deploy with only 10 ETH in contract
      const { id, contractAddress } =
        await deployClaimContractWithCustomBalance(
          router,
          root,
          erc20,
          owner,
          superHighMultiplier,
          parseEther('10'), // only 10 ETH in contract
          true,
          zeroAddress,
          0,
          0
        )

      // Use a normal allocation
      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')
      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])
      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )
      // 100% stake, lockup > 0
      const claimOptions = {
        percentageToClaim: 0,
        percentageToStake: 10_000, // 100% staked (in bips)
        lockupPeriod: 100,
        optionId: keccak256(new TextEncoder().encode('super-bonus')),
      }
      const args = await makeClaimArgs(
        inClaimList,
        {
          id,
          proof,
          totalAllocation,
          opts: claimOptions,
        },
        contractAddress,
      )
      await expect(routerAsClaimList.write.claim(args)).to.be.rejectedWith(
        'OutOfTokens'
      )
    })
  })
  describe('Custom Staking Contract Integration', function () {
    it('Should deploy claim contract with custom staking contract', async function () {
      const { router, owner, root, erc20 } = await deployFixture()

      // Deploy custom test staking contract
      const testStake = await hre.viem.deployContract('MockStake')

      // Deploy claim contract with custom staking
      const { id, contractAddress } = await deployClaimContractWithMultiplier(
        router,
        root,
        erc20,
        owner,
        0n, // no multiplier
        true, // with staking
        testStake.address, // custom staking contract
        0, // min lockup
        0 // min lockup for multiplier
      )

      // Verify custom staking contract is used
      const stakingAddress = await getClaimStakingAddress(router, id)
      expect(stakingAddress).to.equal(getAddress(testStake.address))

      // Verify claim data shows custom staking address
      const claimData = await getClaimData(router, id, zeroAddress)
      expect(claimData.stakingAddress).to.equal(getAddress(testStake.address))
    })

    it('Should revert when trying to use contract that does not implement IBaseStake', async function () {
      const { router, owner, root, erc20 } = await deployFixture()

      // Try to deploy claim contract with contract that does not implement IBaseStake
      // This should revert because the contract does not implement IBaseStake interface
      await expect(
        deployClaimContractWithMultiplier(
          router,
          root,
          erc20,
          owner,
          0n, // no multiplier
          true, // with staking
          erc20.address, // ERC20 token as staking contract (should fail)
          0, // min lockup
          0 // min lockup for multiplier
        )
      ).to.be.rejected
    })
  })

  // ───────────── Pause/Unpause Tests ─────────────────────────────
  describe('Pause/Unpause Functionality', function () {
    it('Should pause and unpause claim contract via router', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { id, contractAddress } = await deployClaimContract(
        router,
        root,
        erc20,
        owner
      )

      // Get claim contract instance
      const claimContract = await hre.viem.getContractAt(
        'SnagAirdropClaim',
        contractAddress
      )
      // Pause via router
      await router.write.pause([id])
      expect(await claimContract.read.paused()).to.be.true

      // Unpause via router (should succeed regardless of initial state)
      await router.write.unpause([id])
      expect(await claimContract.read.paused()).to.be.false

      // Unpause again
      await router.write.pause([id])
      expect(await claimContract.read.paused()).to.be.true
    })

    it('Should revert when non-admin tries to pause/unpause', async function () {
      const { router, owner, root, erc20, otherAccount } = await deployFixture()
      const { id } = await deployClaimContract(router, root, erc20, owner)

      const routerAsOther = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: otherAccount } }
      )

      // Non-admin should not be able to pause
      await expect(routerAsOther.write.pause([id])).to.be.rejectedWith(
        'NotAirdropAdmin'
      )

      // Non-admin should not be able to unpause
      await expect(routerAsOther.write.unpause([id])).to.be.rejectedWith(
        'NotAirdropAdmin'
      )
    })

    it('Should revert when trying to pause/unpause non-existent airdrop', async function () {
      const { router, owner } = await deployFixture()
      const nonExistentId = createRandomId()

      // Should revert for non-existent ID
      await expect(router.write.pause([nonExistentId])).to.be.rejectedWith(
        'InvalidId'
      )

      await expect(router.write.unpause([nonExistentId])).to.be.rejectedWith(
        'InvalidId'
      )
    })

    it('Should revert when airdrop is paused', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()
      const { id } = await deployClaimContract(router, root, erc20, owner)
      await router.write.pause([id])

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Try to claim from paused airdrop
      await expect(
        executeClaim(
          routerAsClaimList,
          inClaimList,
          id,
          proof,
          totalAllocation,
          CLAIM_OPTIONS.FULL_CLAIM
        )
      ).to.be.rejectedWith('EnforcedPause')

      await router.write.unpause([id])
      await expect(
        executeClaim(
          routerAsClaimList,
          inClaimList,
          id,
          proof,
          totalAllocation,
          CLAIM_OPTIONS.FULL_CLAIM
        )
      ).to.not.be.rejected
    })
    it('Should revert when not called from the router', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()
      const { id, contractAddress } = await deployClaimContract(
        router,
        root,
        erc20,
        owner
      )

      const claimContract = await hre.viem.getContractAt(
        'SnagAirdropClaim',
        contractAddress
      )
      await expect(claimContract.write.pause()).to.be.rejectedWith('OnlyRouter')
    })

  })

  // ───────────── Validation Error Tests ─────────────────────────────
  describe('Validation Error Conditions', function () {
    it('Should revert when percentage sum exceeds 10_000', async function () {
      const { routerAsClaimList, inClaimList, id, proof, totalAllocation } =
        await setupClaimTest()

      // Create invalid claim options with sum > 100
      const invalidOptions = {
        percentageToClaim: 6_000,
        percentageToStake: 5_000, // 60% + 50% = 110% > 100% (in bips)
        lockupPeriod: 100,
        optionId: keccak256(new TextEncoder().encode('invalid-option')),
      }

      await expect(
        executeClaim(
          routerAsClaimList,
          inClaimList,
          id,
          proof,
          totalAllocation,
          invalidOptions
        )
      ).to.be.rejectedWith('PctSumExceeded')
    })

    it('Should revert when optionId is zero', async function () {
      const { routerAsClaimList, inClaimList, id, proof, totalAllocation } =
        await setupClaimTest()

      // Create invalid claim options with zero optionId
      const invalidOptions = {
        percentageToClaim: 100,
        percentageToStake: 0,
        lockupPeriod: 0,
        optionId:
          '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      }

      await expect(
        executeClaim(
          routerAsClaimList,
          inClaimList,
          id,
          proof,
          totalAllocation,
          invalidOptions
        )
      ).to.be.rejectedWith('InvalidOptionId')
    })

    it('Should revert when staking is requested but no staking contract', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()

      // Deploy WITHOUT staking
      const { id } = await deployClaimContract(
        router,
        root,
        erc20,
        owner,
        false
      )

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Try to stake when no staking contract exists
      const stakeOnlyOptions = {
        percentageToClaim: 0,
        percentageToStake: 10_000, // 100% staked (in bips)
        lockupPeriod: 100,
        optionId: keccak256(new TextEncoder().encode('stake-only')),
      }

      await expect(
        executeClaim(
          routerAsClaimList,
          inClaimList,
          id,
          proof,
          totalAllocation,
          stakeOnlyOptions
        )
      ).to.be.rejectedWith('NoStaking')
    })

    it('Should revert when lockup period is too short', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()

      // Deploy with minimum lockup duration
      const minLockupDuration = 100 // 100 seconds minimum
      const { id } = await deployClaimContractWithMultiplier(
        router,
        root,
        erc20,
        owner,
        0n,
        true,
        zeroAddress,
        minLockupDuration,
        0
      )

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Try to stake with lockup period below minimum
      const shortLockupOptions = {
        percentageToClaim: 0,
        percentageToStake: 100,
        lockupPeriod: 50, // 50 seconds < 100 minimum
        optionId: keccak256(new TextEncoder().encode('short-lockup')),
      }

      await expect(
        executeClaim(
          routerAsClaimList,
          inClaimList,
          id,
          proof,
          totalAllocation,
          shortLockupOptions
        )
      ).to.be.rejectedWith('LockupTooShort')
    })

    it('Should revert when airdrop is not active', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()
      const { id, contractAddress } = await deployClaimContract(
        router,
        root,
        erc20,
        owner
      )

      // End the airdrop (deactivates it)
      await router.write.endAirdrop([id, owner.account.address])

      const claimListEntry = findUserInClaimList(
        claimList,
        inClaimList.account.address
      )
      if (!claimListEntry) throw new Error('User not found in claim list')

      const proof = getMerkleProof(tree, claimListEntry)
      const totalAllocation = BigInt(claimListEntry[1])

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Try to claim from inactive airdrop
      await expect(
        executeClaim(
          routerAsClaimList,
          inClaimList,
          id,
          proof,
          totalAllocation,
          CLAIM_OPTIONS.FULL_CLAIM
        )
      ).to.be.rejectedWith('AirdropNotActive')
    })

    it('Should revert when invalid Merkle proof is provided', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } =
        await deployFixture()
      const { id } = await deployClaimContract(router, root, erc20, owner)

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Create invalid proof (wrong leaf)
      const invalidProof = [
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      ] as `0x${string}`[]

      const args = await makeClaimArgs(
        inClaimList,
        {
          id,
          proof: invalidProof,
          totalAllocation: parseEther('100'),
          opts: CLAIM_OPTIONS.FULL_CLAIM,
        },
        await routerAsClaimList.read.claimContractById([id]),
      )

      // Should fail with invalid proof
      await expect(routerAsClaimList.write.claim(args)).to.be.rejectedWith(
        'InvalidProof'
      )
    })
  })

  // ───────────── Router Deployment Error Tests ─────────────────────────────
  describe('Router Deployment Error Conditions', function () {
    it('Should revert when deploying with existing ID', async function () {
      const { router, owner, root, erc20 } = await deployFixture()

      // Deploy first contract
      const { id } = await deployClaimContract(router, root, erc20, owner)

      // Try to deploy again with same ID
      await expect(
        router.write.deployClaimContract([
          id, // Use same ID
          root,
          0n, // multiplier
          maxUint256, // maxBonus
          erc20.address,
          zeroAddress, // override staking
          owner.account.address, // admin
          true, // with staking
          0, // min lockup
          0, // min lockup for multiplier
        ])
      ).to.be.rejectedWith('IdExists')
    })

    it('Should revert when deploying with zero admin address', async function () {
      const { router, root, erc20 } = await deployFixture()

      // Try to deploy with zero admin
      await expect(
        router.write.deployClaimContract([
          createRandomId(),
          root,
          0n, // multiplier
          maxUint256, // maxBonus
          erc20.address,
          zeroAddress, // override staking
          zeroAddress, // zero admin
          true, // with staking
          0, // min lockup
          0, // min lockup for multiplier
        ])
      ).to.be.rejectedWith('ZeroAdmin')
    })

    it('Should revert when non-router tries to call admin functions', async function () {
      const { router, owner, root, erc20, otherAccount } = await deployFixture()
      const { id } = await deployClaimContract(router, root, erc20, owner)

      const routerAsOther = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: otherAccount } }
      )

      // Non-router should not be able to set multiplier
      await expect(
        routerAsOther.write.setMultiplier([id, 1000n])
      ).to.be.rejectedWith('NotAirdropAdmin')

      // Non-router should not be able to end airdrop
      await expect(
        routerAsOther.write.endAirdrop([id, otherAccount.account.address])
      ).to.be.rejected
    })

    it('Should revert when calling admin functions on non-existent airdrop', async function () {
      const { router, owner } = await deployFixture()
      const nonExistentId = createRandomId()

      // Should revert for non-existent ID
      await expect(
        router.write.setMultiplier([nonExistentId, 1000n])
      ).to.be.rejectedWith('InvalidId')

      await expect(
        router.write.endAirdrop([nonExistentId, owner.account.address])
      ).to.be.rejectedWith('InvalidId')
    })

    it('Should revert when calling claim on non-existent airdrop', async function () {
      const { router, inClaimList } = await deployFixture()
      const nonExistentId = createRandomId()

      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      )

      // Create dummy claim args
      const dummyProof = [
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      ] as `0x${string}`[]
      const dummyOptions = {
        percentageToClaim: 10_000, // 100% claimed (in bips)
        percentageToStake: 0,
        lockupPeriod: 0,
        optionId: keccak256(new TextEncoder().encode('dummy')),
      }

      const args = await makeClaimArgs(
        inClaimList,
        {
          id: nonExistentId,
          proof: dummyProof,
          totalAllocation: parseEther('100'),
          opts: dummyOptions,
        },
        zeroAddress, // dummy contract address
      )

      // Should fail with invalid ID
      await expect(routerAsClaimList.write.claim(args)).to.be.rejectedWith(
        'InvalidId'
      )
    })
  })

  // ───────────── Edge Cases and Additional Coverage ─────────────────────────────
  describe('Edge Cases and Additional Coverage', function () {
    it('Should handle claim with zero amounts', async function () {
      const { routerAsClaimList, inClaimList, id, proof, totalAllocation } =
        await setupClaimTest()

      // Create claim options with zero amounts
      const zeroOptions = {
        percentageToClaim: 0,
        percentageToStake: 0,
        lockupPeriod: 0,
        optionId: keccak256(new TextEncoder().encode('zero-claim')),
      }

      // This should succeed but transfer no tokens
      await executeClaim(
        routerAsClaimList,
        inClaimList,
        id,
        proof,
        totalAllocation,
        zeroOptions
      )

      // Verify no tokens were transferred
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )
      expect(claimData.totalClaimed).to.equal(0n)
      expect(claimData.totalStaked).to.equal(0n)
    })

    it('Should handle claim with only staking (no direct claim)', async function () {
      const { routerAsClaimList, inClaimList, id, proof, totalAllocation } =
        await setupClaimTest()

      // Create claim options with only staking
      const stakeOnlyOptions = {
        percentageToClaim: 0,
        percentageToStake: 10_000, // 100% staked (in bips)
        lockupPeriod: 100,
        optionId: keccak256(new TextEncoder().encode('stake-only')),
      }

      // Ensure enough tokens are available for staking
      // (setupClaimTest already transfers 160 ETH, increase if needed)
      // If you still get insufficient balance, transfer more here:
      // const claimContractAddress = await routerAsClaimList.read.claimContractById([id])
      // await erc20.write.transfer([claimContractAddress, parseEther('1000')])

      await executeClaim(
        routerAsClaimList,
        inClaimList,
        id,
        proof,
        totalAllocation,
        stakeOnlyOptions
      )

      // Verify all tokens were staked
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )
      expect(claimData.totalClaimed).to.equal(0n)
      expect(claimData.totalStaked).to.equal(totalAllocation)
    })

    it('Should handle claim with only direct claim (no staking)', async function () {
      const { routerAsClaimList, inClaimList, id, proof, totalAllocation } =
        await setupClaimTest()

      // Create claim options with only direct claim
      const claimOnlyOptions = {
        percentageToClaim: 10_000, // 100% claimed (in bips)
        percentageToStake: 0,
        lockupPeriod: 0,
        optionId: keccak256(new TextEncoder().encode('claim-only')),
      }

      await executeClaim(
        routerAsClaimList,
        inClaimList,
        id,
        proof,
        totalAllocation,
        claimOnlyOptions
      )

      // Verify all tokens were claimed directly
      const claimData = await getClaimData(
        routerAsClaimList,
        id,
        inClaimList.account.address
      )
      expect(claimData.totalClaimed).to.equal(totalAllocation)
      expect(claimData.totalStaked).to.equal(0n)
    })

    it('Should handle staking data for user with no stakes', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { id } = await deployClaimContract(router, root, erc20, owner)

      // Get staking data for user with no stakes
      const stakingData = await getClaimStakingData(
        router,
        id,
        owner.account.address
      )
      const [stakeIds = [], claimableAmounts = [], totalClaimable = 0n] =
        stakingData || []
      expect(stakeIds.length).to.equal(0)
      expect(claimableAmounts.length).to.equal(0)
      expect(totalClaimable).to.equal(0n)
    })

    it('Should handle airdrop without staking for staking data', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { id } = await deployClaimContract(
        router,
        root,
        erc20,
        owner,
        false
      ) // no staking

      // Get staking data for airdrop without staking
      const stakingData = await getClaimStakingData(
        router,
        id,
        owner.account.address
      )
      const [stakeIds = [], claimableAmounts = [], totalClaimable = 0n] =
        stakingData || []
      expect(stakeIds.length).to.equal(0)
      expect(claimableAmounts.length).to.equal(0)
      expect(totalClaimable).to.equal(0n)
    })
  })
})
