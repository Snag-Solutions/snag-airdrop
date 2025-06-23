import { parseEther } from 'viem'
import { expect } from 'chai'
import { 
  getStakingData, 
  getStakeIds, 
  verifyUserBalance, 
  stakeTokens, 
  claimUnlockedAndGetAmount 
} from './shared'

// ───────────── Stake-Specific Verification Functions ──────────────────

/**
 * Verify staking data
 */
export async function verifyStakingData(
  stake: any,
  userAddress: string,
  expectedStakeCount: number,
  expectedTotalClaimable?: bigint
) {
  const stakingData = await getStakingData(stake, userAddress)
  
  expect(stakingData.stakeIds.length).to.equal(expectedStakeCount)
  expect(stakingData.claimableAmounts.length).to.equal(expectedStakeCount)
  
  if (expectedTotalClaimable !== undefined) {
    expect(stakingData.totalClaimable).to.equal(expectedTotalClaimable)
  }
  
  if (expectedStakeCount === 0) {
    expect(stakingData.totalClaimable).to.equal(0n)
  }
}

/**
 * Verify stake creation
 */
export async function verifyStakeCreated(
  stake: any,
  userAddress: string,
  expectedStakeCount: number = 1
) {
  const stakeIds = await getStakeIds(stake, userAddress)
  expect(stakeIds.length).to.equal(expectedStakeCount)
  
  // Verify the stake is in the claimable data
  const stakingData = await getStakingData(stake, userAddress)
  expect(stakingData.stakeIds.length).to.equal(expectedStakeCount)
  expect(stakingData.claimableAmounts.length).to.equal(expectedStakeCount)
}

/**
 * Verify claimable amount is approximately expected
 */
export async function verifyClaimableAmount(
  stake: any,
  userAddress: string,
  expectedAmount: bigint,
  tolerance: bigint = parseEther('0.001')
) {
  const stakingData = await getStakingData(stake, userAddress)
  const totalClaimable = stakingData.totalClaimable
  
  expect(Number(totalClaimable)).to.be.closeTo(
    Number(expectedAmount),
    Number(tolerance)
  )
}

// ───────────── Stake-Specific Setup Functions ────────────────────────

/**
 * Setup multiple stakes for testing
 */
export async function setupMultipleStakes(
  stakeAsUser: any,
  userAddress: string,
  stakes: Array<{ amount: bigint; duration: number }>
) {
  for (const stake of stakes) {
    await stakeTokens(stakeAsUser, userAddress, stake.amount, stake.duration)
  }
} 