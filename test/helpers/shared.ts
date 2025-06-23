import hre from 'hardhat'
import { parseEther, keccak256, zeroAddress } from 'viem'
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import { expect } from 'chai'

// ───────────── Shared Interfaces ─────────────────────────────────────

export interface TestSetup {
  router: any
  owner: any
  otherAccount: any
  inClaimList: any
  notInClaimList: any
  publicClient: any
  tree: StandardMerkleTree<[string, bigint]>
  claimList: [string, bigint][]
  root: `0x${string}`
  erc20: any
}

export interface DeployedContract {
  id: `0x${string}`
  contractAddress: `0x${string}`
}

export interface StakeInfo {
  stakeIds: bigint[]
  claimableAmounts: bigint[]
  totalClaimable: bigint
}

// ───────────── Shared Deployment Functions ───────────────────────────

/**
 * Deploy basic test fixtures (router, ERC20, merkle tree)
 */
export async function deployFixture(): Promise<TestSetup> {
  const [owner, otherAccount, inClaimList, notInClaimList] =
    await hre.viem.getWalletClients()

  const router = await hre.viem.deployContract('SnagAirdropRouter')
  const erc20 = await hre.viem.deployContract('MockERC20', [
    owner.account.address,
  ])
  const publicClient = await hre.viem.getPublicClient()

  //@dev  This is how the claim list is created wallet address and amount
  const claimList: [string, bigint][] = [
    [inClaimList.account.address, parseEther('100')],
    [otherAccount.account.address, parseEther('50')],
    [owner.account.address, parseEther('10')],
  ]

  //@dev The tree is created with the claim list and the types of the claim list
  const tree = StandardMerkleTree.of(claimList, ['address', 'uint256'])

  //@dev root is taken form the tree created with the oz package
  //the tree will be used to create the proof for the claim
  const root = tree.root as `0x${string}`

  return {
    router,
    owner,
    otherAccount,
    inClaimList,
    notInClaimList,
    publicClient,
    tree,
    claimList,
    root,
    erc20,
  }
}

/**
 * Deploy a stake contract with ERC20
 */
export async function deployStakeFixture(): Promise<{
  owner: any
  user: any
  erc20: any
  stake: any
  stakeAsUser: any
  erc20AsUser: any
}> {
  const [owner, user] = await hre.viem.getWalletClients()

  // Deploy a mock ERC20 that mints to `owner`
  const erc20 = await hre.viem.deployContract('MockERC20', [
    owner.account.address,
  ])

  // Deploy the staking contract
  const stake = await hre.viem.deployContract('LinearStake', [erc20.address])

  // Give the user some tokens and approve the stake contract
  await erc20.write.transfer([user.account.address, parseEther('1000')])
  
  const erc20AsUser = await hre.viem.getContractAt(
    'MockERC20',
    erc20.address,
    { client: { wallet: user } }
  )
  await erc20AsUser.write.approve([stake.address, parseEther('1000')])

  const stakeAsUser = await hre.viem.getContractAt(
    'LinearStake',
    stake.address,
    { client: { wallet: user } }
  )

  return { owner, user, erc20, stake, stakeAsUser, erc20AsUser }
}

// ───────────── Shared Utility Functions ──────────────────────────────

/**
 * Verify user token balance
 */
export async function verifyUserBalance(
  erc20: any,
  userAddress: string,
  expectedBalance: bigint
) {
  const userBalance = await erc20.read.balanceOf([userAddress])
  expect(userBalance).to.equal(expectedBalance)
}

/**
 * Get user balance before and after an action
 */
export async function getBalanceChange(
  erc20: any,
  userAddress: string,
  action: () => Promise<any>
): Promise<bigint> {
  const balanceBefore = await erc20.read.balanceOf([userAddress])
  await action()
  const balanceAfter = await erc20.read.balanceOf([userAddress])
  return BigInt(balanceAfter - balanceBefore)
}

/**
 * Create a random airdrop ID
 */
export function createRandomId(): `0x${string}` {
  return keccak256(new TextEncoder().encode(Math.random().toString()))
}

/**
 * Find user in claim list
 */
export function findUserInClaimList(claimList: [string, bigint][], userAddress: string): [string, bigint] | undefined {
  return claimList.find((entry) => entry[0] === userAddress)
}

/**
 * Get merkle proof for a user
 */
export function getMerkleProof(tree: StandardMerkleTree<[string, bigint]>, claimListEntry: [string, bigint]): `0x${string}`[] {
  return tree.getProof(claimListEntry) as `0x${string}`[]
}

// ───────────── Shared Staking Functions ──────────────────────────────

/**
 * Get staking data for a user (stake contract context)
 */
export async function getStakingData(
  stake: any,
  userAddress: string,
  stakeId: bigint = 0n
): Promise<StakeInfo> {
  const [stakeIds, claimableAmounts] = await stake.read.claimable([
    stakeId,
    userAddress,
  ])
  
  // Calculate total claimable
  const totalClaimable = claimableAmounts.reduce((sum: bigint, amount: bigint) => sum + amount, 0n)
  
  return {
    stakeIds,
    claimableAmounts,
    totalClaimable,
  }
}

/**
 * Get all stake IDs for a user
 */
export async function getStakeIds(stake: any, userAddress: string): Promise<bigint[]> {
  return await stake.read.getStakeIds([userAddress])
}

/**
 * Stake tokens for a user
 */
export async function stakeTokens(
  stakeAsUser: any,
  userAddress: string,
  amount: bigint,
  duration: number
) {
  return await stakeAsUser.write.stakeFor([userAddress, amount, duration])
}

/**
 * Claim unlocked tokens
 */
export async function claimUnlocked(
  stakeAsUser: any,
  stakeId: bigint = 0n
): Promise<string> {
  return await stakeAsUser.write.claimUnlocked([stakeId])
}

/**
 * Claim unlocked tokens and return the actual claimed amount
 */
export async function claimUnlockedAndGetAmount(
  stakeAsUser: any,
  erc20: any,
  userAddress: string,
  stakeId: bigint = 0n
): Promise<bigint> {
  return await getBalanceChange(
    erc20,
    userAddress,
    () => claimUnlocked(stakeAsUser, stakeId)
  )
} 