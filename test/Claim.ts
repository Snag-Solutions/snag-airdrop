import {
  time,
  loadFixture,
} from '@nomicfoundation/hardhat-toolbox-viem/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { getAddress, parseGwei, parseEther, keccak256, zeroAddress } from 'viem'
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
  getMerkleProof
} from './helpers/shared'
import { makeClaimArgs } from './helpers/makeClaimArgs'

describe('Claim', function () {
  // ───────────── Admin Tests ─────────────────────────────────────
  
  describe('Admin Flows', function () {
    it('should deploy a claim contract', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { contractAddress } = await deployClaimContract(router, root, erc20, owner)
      expect(contractAddress).to.not.equal(null)
    })

    it('Should cancel a claim contract', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { id, contractAddress } = await deployClaimContract(router, root, erc20, owner)
      
      const claimContractBalance = await erc20.read.balanceOf([contractAddress])
      const ownerBalance = await erc20.read.balanceOf([owner.account.address])
      
      await router.write.endAirdrop([id, owner.account.address])
      
      const claimContractBalance2 = await erc20.read.balanceOf([contractAddress])
      const ownerBalance2 = await erc20.read.balanceOf([owner.account.address])
      
      expect(claimContractBalance2).to.equal(0n)
      expect(ownerBalance2).to.equal(claimContractBalance + ownerBalance)
    })

    it('Should Update Multiplier on claim contract', async function () {
      const { router, owner, root, erc20 } = await deployFixture()
      const { id, contractAddress } = await deployClaimContract(router, root, erc20, owner)
      
      const claimContract = await hre.viem.getContractAt('SnagAirdropClaim', contractAddress)
      const multiplier = await claimContract.read.multiplier()
      
      await router.write.setMultiplier([id, 100n])
      
      const multiplier2 = await claimContract.read.multiplier()
      expect(multiplier2).to.not.equal(multiplier)
    })
  })

  // ───────────── User Claim Tests ─────────────────────────────────
  
  describe('User Claim Flows', function () {
    it('Should claim tokens with full claim option', async function () {
      const { routerAsClaimList, inClaimList, id, erc20, proof, totalAllocation } = 
        await setupClaimTest()

      await executeClaim(routerAsClaimList, inClaimList, id, proof, totalAllocation, CLAIM_OPTIONS.FULL_CLAIM)
      await verifyUserBalance(erc20, inClaimList.account.address, totalAllocation)
    })

    it('Should claim and stake tokens with half-half option', async function () {
      const { routerAsClaimList, inClaimList, id, erc20, proof, totalAllocation } = 
        await setupClaimTest()

      await executeClaim(routerAsClaimList, inClaimList, id, proof, totalAllocation, CLAIM_OPTIONS.HALF_CLAIM_HALF_STAKE)
      
      // Verify claimed amount (50%)
      await verifyUserBalance(erc20, inClaimList.account.address, totalAllocation / 2n)
      
      // Verify staking data
      await verifyClaimStakingData(routerAsClaimList, id, inClaimList.account.address, 1)
    })

    it('Should claim tokens with partial claim option', async function () {
      const { routerAsClaimList, inClaimList, id, erc20, proof, totalAllocation } = 
        await setupClaimTest()

      // First claim - should succeed
      await executeClaim(routerAsClaimList, inClaimList, id, proof, totalAllocation, CLAIM_OPTIONS.PARTIAL_CLAIM)
      await verifyUserBalance(erc20, inClaimList.account.address, totalAllocation / 2n)

      // Try to claim again - should fail
      await expect(
        executeClaim(routerAsClaimList, inClaimList, id, proof, totalAllocation, CLAIM_OPTIONS.PARTIAL_CLAIM)
      ).to.be.rejectedWith('AlreadyClaimed')

      // Verify balance hasn't changed
      await verifyUserBalance(erc20, inClaimList.account.address, totalAllocation / 2n)
    })

    it('Should reject claim with incorrect signature', async function () {
      const { router, owner, root, erc20, inClaimList, otherAccount, tree, claimList } = await deployFixture()
      const { id } = await deployClaimContract(router, root, erc20, owner)

      const claimListEntry = findUserInClaimList(claimList, inClaimList.account.address)
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
        otherAccount, // Wrong signer - should be inClaimList
        {
          id,
          proof,
          totalAllocation,
          opts: CLAIM_OPTIONS.FULL_CLAIM,
        },
        await routerAsClaimList.read.claimContractById([id]),
        router.address
      )

      // Should fail because signature doesn't match the beneficiary
      await expect(
        routerAsClaimList.write.claim(args)
      ).to.be.rejectedWith('InvalidSignature')

      // Verify no tokens were claimed
      await verifyUserBalance(erc20, inClaimList.account.address, 0n)
    })
  })

  // ───────────── Multiplier Tests ─────────────────────────────────
  
  describe('Multiplier Logic', function () {
    it('Should apply multiplier when lockup period meets threshold', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } = await deployFixture()
      
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

      const claimListEntry = findUserInClaimList(claimList, inClaimList.account.address)
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
        percentageToStake: 100,
        lockupPeriod: 120, // 120 seconds > 60 second threshold
        optionId: keccak256(new TextEncoder().encode('test-option'))
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
        router.address
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts
      const expectedStaked = totalAllocation // 100% staked
      const expectedBonus = (expectedStaked * multiplier) / 10000n // 10% bonus
      const expectedTotalStaked = expectedStaked + expectedBonus

      // Verify staking data shows the bonus tokens were staked
      await verifyClaimStakingData(routerAsClaimList, id, inClaimList.account.address, 1)

      // Get claim data to verify bonus was applied
      const claimData = await getClaimData(routerAsClaimList, id, inClaimList.account.address)
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })

    it('Should NOT apply multiplier when lockup period below threshold', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } = await deployFixture()
      
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

      const claimListEntry = findUserInClaimList(claimList, inClaimList.account.address)
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
        percentageToStake: 100,
        lockupPeriod: 45, // 45 seconds < 60 second threshold
        optionId: keccak256(new TextEncoder().encode('test-option'))
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
        router.address
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts (no bonus)
      const expectedStaked = totalAllocation
      const expectedBonus = 0n

      // Verify staking data
      await verifyClaimStakingData(routerAsClaimList, id, inClaimList.account.address, 1)

      // Get claim data to verify NO bonus was applied
      const claimData = await getClaimData(routerAsClaimList, id, inClaimList.account.address)
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })

    it('Should NOT apply multiplier when multiplier is zero', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } = await deployFixture()
      
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

      const claimListEntry = findUserInClaimList(claimList, inClaimList.account.address)
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
        percentageToStake: 100,
        lockupPeriod: 120, // > threshold
        optionId: keccak256(new TextEncoder().encode('test-option'))
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
        router.address
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts (no bonus because multiplier is 0)
      const expectedStaked = totalAllocation
      const expectedBonus = 0n

      // Verify staking data
      await verifyClaimStakingData(routerAsClaimList, id, inClaimList.account.address, 1)

      // Get claim data to verify NO bonus was applied
      const claimData = await getClaimData(routerAsClaimList, id, inClaimList.account.address)
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })

    it('Should apply multiplier to partial stake amounts', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } = await deployFixture()
      
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

      const claimListEntry = findUserInClaimList(claimList, inClaimList.account.address)
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
        percentageToClaim: 30, // 30% claimed
        percentageToStake: 70, // 70% staked
        lockupPeriod: 120, // > threshold
        optionId: keccak256(new TextEncoder().encode('test-option'))
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
        router.address
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts
      const expectedClaimed = (totalAllocation * 30n) / 100n
      const expectedStaked = (totalAllocation * 70n) / 100n
      const expectedBonus = (expectedStaked * multiplier) / 10000n // 20% bonus on staked amount
      const expectedTotalStaked = expectedStaked + expectedBonus

      // Verify user received claimed amount
      await verifyUserBalance(erc20, inClaimList.account.address, expectedClaimed)

      // Verify staking data
      await verifyClaimStakingData(routerAsClaimList, id, inClaimList.account.address, 1)

      // Get claim data to verify bonus was applied correctly
      const claimData = await getClaimData(routerAsClaimList, id, inClaimList.account.address)
      expect(claimData.totalClaimed).to.equal(expectedClaimed)
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })

    it('Should handle multiplier update after deployment', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } = await deployFixture()
      
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

      const claimListEntry = findUserInClaimList(claimList, inClaimList.account.address)
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
        percentageToStake: 100,
        lockupPeriod: 120, // > threshold
        optionId: keccak256(new TextEncoder().encode('test-option'))
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
        router.address
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts with NEW multiplier
      const expectedStaked = totalAllocation
      const expectedBonus = (expectedStaked * newMultiplier) / 10000n // 15% bonus

      // Verify staking data
      await verifyClaimStakingData(routerAsClaimList, id, inClaimList.account.address, 1)

      // Get claim data to verify NEW multiplier was applied
      const claimData = await getClaimData(routerAsClaimList, id, inClaimList.account.address)
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(newMultiplier)
    })

    it('Should handle edge case: exact threshold lockup period', async function () {
      const { router, owner, root, erc20, inClaimList, tree, claimList } = await deployFixture()
      
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

      const claimListEntry = findUserInClaimList(claimList, inClaimList.account.address)
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
        percentageToStake: 100,
        lockupPeriod: 60, // Exactly equal to threshold
        optionId: keccak256(new TextEncoder().encode('test-option'))
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
        router.address
      )

      // Execute claim
      await routerAsClaimList.write.claim(args)

      // Calculate expected amounts (should get bonus because >= threshold)
      const expectedStaked = totalAllocation
      const expectedBonus = (expectedStaked * multiplier) / 10000n

      // Verify staking data
      await verifyClaimStakingData(routerAsClaimList, id, inClaimList.account.address, 1)

      // Get claim data to verify bonus was applied
      const claimData = await getClaimData(routerAsClaimList, id, inClaimList.account.address)
      expect(claimData.totalStaked).to.equal(expectedStaked)
      expect(claimData.totalBonusTokens).to.equal(expectedBonus)
      expect(claimData.multiplier).to.equal(multiplier)
    })
  })

  // ───────────── Data Retrieval Tests ─────────────────────────────
  
  describe('Data Retrieval', function () {
    it('Should get staking data via router', async function () {
      const { routerAsClaimList, inClaimList, id, proof, totalAllocation } = await setupClaimTest()

      await executeClaim(routerAsClaimList, inClaimList, id, proof, totalAllocation, CLAIM_OPTIONS.HALF_CLAIM_HALF_STAKE)
      await verifyClaimStakingData(routerAsClaimList, id, inClaimList.account.address, 1)
    })

    it('Should get claim data via router', async function () {
      const { routerAsClaimList, inClaimList, id, erc20, proof, totalAllocation } = await setupClaimTest()

      await executeClaim(routerAsClaimList, inClaimList, id, proof, totalAllocation, CLAIM_OPTIONS.PARTIAL_CLAIM)

      // Get claim data for specific user
      const claimData = await getClaimData(routerAsClaimList, id, inClaimList.account.address)

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
      const claimDataZeroAddress = await getClaimData(routerAsClaimList, id, zeroAddress)
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
      const { id } = await deployClaimContract(router, root, erc20, owner, false) // no staking

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
      const { router, owner, erc20 } = await deployFixture();
      
      // Create a new merkle tree with a big user allocation
      const bigUser = (await hre.viem.getWalletClients())[4];
      const bigAllocation = parseEther('100');
      const claimList: [string, bigint][] = [
        [bigUser.account.address, bigAllocation],
      ];
      const tree = StandardMerkleTree.of(claimList, ['address', 'uint256']);
      const root = tree.root as `0x${string}`;
      
      // Deploy claim contract with only 1 ETH in balance
      const { id, contractAddress } = await deployClaimContractWithCustomBalance(
        router, 
        root, 
        erc20, 
        owner, 
        0n, // no multiplier
        parseEther('1'), // only 1 ETH in contract
        true
      );

      // Create proper claim options and proof
      const claimOptions = {
        percentageToClaim: 100,
        percentageToStake: 0,
        lockupPeriod: 0,
        optionId: keccak256(new TextEncoder().encode('big-claim')),
      };
      const claimListEntry = findUserInClaimList(claimList, bigUser.account.address);
      if (!claimListEntry) throw new Error('User not found in claim list');
      const proof = getMerkleProof(tree, claimListEntry);
      
      const routerAsBigUser = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: bigUser } }
      );
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
        router.address
      );
      await expect(routerAsBigUser.write.claim(args)).to.be.rejectedWith('OutOfTokens');
    });

    it('should revert with OutOfTokens if multiplier bonus causes contract to run out of tokens', async function () {
      // Setup: deploy with a super high multiplier
      const { router, owner, root, erc20, inClaimList, tree, claimList } = await deployFixture();
      const superHighMultiplier = 100_000n; // 1000% bonus
      // Deploy with only 10 ETH in contract
      const { id, contractAddress } = await deployClaimContractWithCustomBalance(
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
      );
      
      // Use a normal allocation
      const claimListEntry = findUserInClaimList(claimList, inClaimList.account.address);
      if (!claimListEntry) throw new Error('User not found in claim list');
      const proof = getMerkleProof(tree, claimListEntry);
      const totalAllocation = BigInt(claimListEntry[1]);
      const routerAsClaimList = await hre.viem.getContractAt(
        'SnagAirdropRouter',
        router.address,
        { client: { wallet: inClaimList } }
      );
      // 100% stake, lockup > 0
      const claimOptions = {
        percentageToClaim: 0,
        percentageToStake: 100,
        lockupPeriod: 100,
        optionId: keccak256(new TextEncoder().encode('super-bonus')),
      };
      const args = await makeClaimArgs(
        inClaimList,
        {
          id,
          proof,
          totalAllocation,
          opts: claimOptions,
        },
        contractAddress,
        router.address
      );
      await expect(routerAsClaimList.write.claim(args)).to.be.rejectedWith('OutOfTokens');
    });
  })
})
