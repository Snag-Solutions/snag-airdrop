import hre from 'hardhat'
import { parseEther, keccak256, zeroAddress } from 'viem'
import { ClaimOptions, makeClaimArgs } from './makeClaimArgs'
import { 
  TestSetup, 
  DeployedContract, 
  deployFixture, 
  createRandomId, 
  findUserInClaimList, 
  getMerkleProof
} from './shared'
import { expect } from 'chai'

// ───────────── Claim Options ──────────────────────────────────────────

export const CLAIM_OPTIONS: Record<string, ClaimOptions> = {
  // Claim 100% of tokens immediately
  FULL_CLAIM: {
    optionId: keccak256(new TextEncoder().encode('full-claim')),
    percentageToClaim: 100,
    percentageToStake: 0,
    lockupPeriod: 0,
  },
  // Claim 50% and stake 50% for 30 days
  HALF_CLAIM_HALF_STAKE: {
    optionId: keccak256(new TextEncoder().encode('half-claim-half-stake')),
    percentageToClaim: 50,
    percentageToStake: 50,
    lockupPeriod: 30 * 24 * 60 * 60, // 30 days in seconds
  },
  // Stake 100% for 90 days
  FULL_STAKE: {
    optionId: keccak256(new TextEncoder().encode('full-stake')),
    percentageToClaim: 0,
    percentageToStake: 100,
    lockupPeriod: 90 * 24 * 60 * 60, // 90 days in seconds
  },
  // Claim 75% and stake 25% for 60 days
  PARTIAL_CLAIM_STAKE: {
    optionId: keccak256(new TextEncoder().encode('partial-claim-stake')),
    percentageToClaim: 75,
    percentageToStake: 25,
    lockupPeriod: 60 * 24 * 60 * 60, // 60 days in seconds
  },
  // Claim  50% and no staking
  PARTIAL_CLAIM: {
    optionId: keccak256(new TextEncoder().encode('partial-claim')),
    percentageToClaim: 50,
    percentageToStake: 0,
    lockupPeriod: 0,
  },
} as const

// ───────────── Claim-Specific Interfaces ─────────────────────────────

export interface ClaimTestSetup extends TestSetup {
  routerAsClaimList: any
  id: `0x${string}`
  proof: `0x${string}`[]
  totalAllocation: bigint
  claimListEntry: [string, bigint]
  contractAddress: `0x${string}`
}

// ───────────── Claim-Specific Deployment Functions ────────────────────

/**
 * Deploy a claim contract with optional staking
 */
export async function deployClaimContract(
  router: any,
  root: `0x${string}`,
  erc20: any,
  owner: any,
  withStaking: boolean = true
): Promise<DeployedContract> {
  const id = createRandomId()
  await router.write.deployClaimContract([
    id,
    root,
    0n, // multiplier
    erc20.address, // assetAddress
    zeroAddress, // overrideStakingAddress
    owner.account.address, // admin
    withStaking,
    0, // minLockupDuration
    0, // minLockupDurationForMultiplier
  ])
  const contractAddress = await router.read.claimContractById([id])
  await erc20.write.transfer([contractAddress, parseEther('10000')])
  await router.write.unpause([id])
  return { id, contractAddress }
}

/**
 * Deploy a claim contract with multiplier parameters
 */
export async function deployClaimContractWithMultiplier(
  router: any,
  root: `0x${string}`,
  erc20: any,
  owner: any,
  multiplier: bigint,
  withStaking: boolean = true,
  overrideStakingAddress: `0x${string}` = zeroAddress,
  minLockupDuration: number = 0,
  minLockupDurationForMultiplier: number = 0
): Promise<DeployedContract> {
  const id = createRandomId()
  await router.write.deployClaimContract([
    id,
    root,
    multiplier,
    erc20.address, // assetAddress
    overrideStakingAddress,
    owner.account.address, // admin
    withStaking,
    minLockupDuration,
    minLockupDurationForMultiplier,
  ])
  const contractAddress = await router.read.claimContractById([id])
  // Transfer more tokens to account for potential bonus amounts
  await erc20.write.transfer([contractAddress, parseEther('10000')])
  await router.write.unpause([id])
  return { id, contractAddress }
}

/**
 * Deploy a claim contract with custom token balance for testing
 */
export async function deployClaimContractWithCustomBalance(
  router: any,
  root: `0x${string}`,
  erc20: any,
  owner: any,
  multiplier: bigint,
  customBalance: bigint,
  withStaking: boolean = true,
  overrideStakingAddress: `0x${string}` = zeroAddress,
  minLockupDuration: number = 0,
  minLockupDurationForMultiplier: number = 0
): Promise<DeployedContract> {
  const id = createRandomId()
  await router.write.deployClaimContract([
    id,
    root,
    multiplier,
    erc20.address, // assetAddress
    overrideStakingAddress,
    owner.account.address, // admin
    withStaking,
    minLockupDuration,
    minLockupDurationForMultiplier,
  ])
  const contractAddress = await router.read.claimContractById([id])
  // Transfer custom amount instead of default
  await erc20.write.transfer([contractAddress, customBalance])
  await router.write.unpause([id])
  return { id, contractAddress }
}

// ───────────── Claim-Specific Setup Functions ────────────────────────

/**
 * Setup complete test environment for claim testing
 */
export async function setupClaimTest(withStaking: boolean = true): Promise<ClaimTestSetup> {
  const { router, owner, root, erc20, inClaimList, tree, claimList } = await deployFixture()
  const { id, contractAddress } = await deployClaimContract(router, root, erc20, owner, withStaking)
  
  const claimListEntry = findUserInClaimList(claimList, inClaimList.account.address)
  if (!claimListEntry) throw new Error('User not found in claim list')

  const proof = getMerkleProof(tree, claimListEntry)
  const totalAllocation = BigInt(claimListEntry[1])

  const routerAsClaimList = await hre.viem.getContractAt(
    'SnagAirdropRouter',
    router.address,
    { client: { wallet: inClaimList } }
  )

  return {
    router,
    routerAsClaimList,
    id,
    erc20,
    inClaimList,
    proof,
    totalAllocation,
    claimListEntry,
    contractAddress,
    owner,
    otherAccount: (await hre.viem.getWalletClients())[1],
    notInClaimList: (await hre.viem.getWalletClients())[3],
    publicClient: await hre.viem.getPublicClient(),
    tree,
    claimList,
    root,
  }
}

// ───────────── Claim-Specific Execution Functions ─────────────────────

/**
 * Execute a claim with proper signature creation
 */
export async function executeClaim(
  routerAsClaimList: any,
  inClaimList: any,
  id: `0x${string}`,
  proof: `0x${string}`[],
  totalAllocation: bigint,
  claimOptions: ClaimOptions
) {
  const claimArgs = await makeClaimArgs(
    inClaimList,
    {
      id,
      proof,
      totalAllocation,
      opts: claimOptions,
    },
    await routerAsClaimList.read.claimContractById([id]),
    routerAsClaimList.address
  )

  return await routerAsClaimList.write.claim(claimArgs)
}

// ───────────── Claim-Specific Verification Functions ──────────────────

/**
 * Verify staking data for claim tests
 */
export async function verifyClaimStakingData(
  router: any,
  id: `0x${string}`,
  userAddress: string,
  expectedStakeCount: number
) {
  const stakingData = await getClaimStakingData(router, id, userAddress);
  // Support both named and numeric keys
  const stakeIds = stakingData?.stakeIds ?? stakingData?.[0] ?? [];
  const claimableAmounts = stakingData?.claimableAmounts ?? stakingData?.[1] ?? [];
  expect(stakeIds.length).to.equal(expectedStakeCount);
  expect(claimableAmounts.length).to.equal(expectedStakeCount);
}

// ───────────── Claim-Specific Data Retrieval Functions ────────────────

/**
 * Get claim data for a user
 */
export async function getClaimData(router: any, id: `0x${string}`, userAddress: string) {
  return await router.read.getClaimData([id, userAddress]);
}

/**
 * Get staking data for a user from router
 */
export async function getClaimStakingData(router: any, id: `0x${string}`, userAddress: string) {
  return await router.read.getStakingData([id, userAddress]);
}

/**
 * Get staking address for a claim contract from router
 */
export async function getClaimStakingAddress(router: any, id: `0x${string}`) {
  return await router.read.getStakingAddress([id]);
} 