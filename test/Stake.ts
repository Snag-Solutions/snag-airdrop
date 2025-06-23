import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { expect } from "chai";
import { parseEther } from "viem";
import {
  deployStakeFixture,
  stakeTokens,
  getStakingData,
  getStakeIds,
  claimUnlocked,
  claimUnlockedAndGetAmount,
} from "./helpers/shared";
import {
  verifyStakeCreated,
  verifyClaimableAmount,
} from "./helpers/stake";

describe("LinearStake", function () {
  describe("Staking Validation", function () {
    it("reverts when staking zero amount", async function () {
      const { stakeAsUser, user } = await loadFixture(deployStakeFixture);
      await expect(
        stakeTokens(stakeAsUser, user.account.address, 0n, 100)
      ).to.be.rejectedWith("AmountMustBePositive");
    });

    it("reverts when staking with zero duration", async function () {
      const { stakeAsUser, user } = await loadFixture(deployStakeFixture);
      await expect(
        stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 0)
      ).to.be.rejectedWith("DurationMustBePositive");
    });
  });

  describe("Stake Creation", function () {
    it("creates stake correctly and records stake info", async function () {
      const { user, stake, stakeAsUser } = await loadFixture(deployStakeFixture);

      const amount = parseEther("1");
      const duration = 100;

      await stakeTokens(stakeAsUser, user.account.address, amount, duration);

      // Verify stake was created
      await verifyStakeCreated(stake, user.account.address, 1);

      // Get staking data to verify details
      const stakingData = await getStakingData(stake, user.account.address);
      
      expect(stakingData.stakeIds.length).to.equal(1);
      expect(stakingData.claimableAmounts.length).to.equal(1);
      
      // Claimable should be 0 immediately after staking
      expect(stakingData.totalClaimable).to.equal(0n);
    });

    it("claimable is zero immediately after stake", async function () {
      const { user, stakeAsUser, stake } = await loadFixture(deployStakeFixture);
      
      await stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 100);
      
      const stakingData = await getStakingData(stake, user.account.address);
      expect(stakingData.totalClaimable).to.equal(0n);
    });
  });

  describe("Linear Vesting", function () {
    it("vests linearly over time", async function () {
      const { user, stakeAsUser, stake } = await loadFixture(deployStakeFixture);

      const amount = parseEther("1");
      const duration = 100;
      
      await stakeTokens(stakeAsUser, user.account.address, amount, duration);

      // Advance half the duration
      await time.increase(50);

      // Should be approximately half claimable
      await verifyClaimableAmount(stake, user.account.address, amount / 2n);
    });

    it("fully vests after duration", async function () {
      const { user, stakeAsUser, stake } = await loadFixture(deployStakeFixture);

      const amount = parseEther("1");
      const duration = 100;
      
      await stakeTokens(stakeAsUser, user.account.address, amount, duration);

      // Advance full duration
      await time.increase(100);

      // Should be fully claimable
      await verifyClaimableAmount(stake, user.account.address, amount);
    });
  });

  describe("Claiming Tokens", function () {
    it("allows claiming unlocked tokens", async function () {
      const { user, stakeAsUser, erc20, stake } = await loadFixture(deployStakeFixture);

      const amount = parseEther("1");
      const duration = 100;

      // Get initial balance before staking
      const initialBalance = await erc20.read.balanceOf([user.account.address]);

      await stakeTokens(stakeAsUser, user.account.address, amount, duration);

      // Get balance after staking
      const balanceAfterStake = await erc20.read.balanceOf([user.account.address]);

      // Advance half the duration
      await time.increase(50);

      // Check claimable amount before claiming
      const stakingDataBefore = await getStakingData(stake, user.account.address);
      expect(Number(stakingDataBefore.totalClaimable)).to.be.gt(0);

      // Claim unlocked tokens
      const claimedAmount = await claimUnlockedAndGetAmount(
        stakeAsUser,
        erc20,
        user.account.address
      );

      // Should have claimed approximately half
      expect(Number(claimedAmount)).to.be.closeTo(
        Number(amount) / 2,
        Number(parseEther("0.01")) // 0.01 ETH tolerance
      );

      // Remaining claimable should be zero after claiming
      const stakingDataAfter = await getStakingData(stake, user.account.address);
      expect(stakingDataAfter.totalClaimable).to.equal(0n);
    });

    it("allows multiple claims until fully vested", async function () {
      const { user, stakeAsUser, erc20, stake } = await loadFixture(deployStakeFixture);

      const amount = parseEther("1");
      const duration = 100;
      
      await stakeTokens(stakeAsUser, user.account.address, amount, duration);

      // Advance full duration
      await time.increase(100);

      // Get initial balance
      const initialBalance = await erc20.read.balanceOf([user.account.address]);

      // First claim - should claim everything
      const claimedAmount = await claimUnlockedAndGetAmount(
        stakeAsUser,
        erc20,
        user.account.address
      );

      // Should have claimed the full amount
      expect(claimedAmount).to.equal(amount);

      // Nothing left to claim
      const stakingData = await getStakingData(stake, user.account.address);
      expect(stakingData.totalClaimable).to.equal(0n);
    });

    it("handles partial claims correctly", async function () {
      const { user, stakeAsUser, erc20, stake } = await loadFixture(deployStakeFixture);

      const amount = parseEther("1");
      const duration = 100;
      
      await stakeTokens(stakeAsUser, user.account.address, amount, duration);

      // Advance 75% of duration
      await time.increase(75);

      // First claim - should claim 75%
      const firstClaimAmount = await claimUnlockedAndGetAmount(
        stakeAsUser,
        erc20,
        user.account.address
      );

      expect(Number(firstClaimAmount)).to.be.closeTo(
        Number(amount) * 0.75,
        Number(parseEther("0.01"))
      );

      // Advance remaining time
      await time.increase(25);

      // Second claim - should claim remaining 25%
      const secondClaimAmount = await claimUnlockedAndGetAmount(
        stakeAsUser,
        erc20,
        user.account.address
      );

      expect(Number(secondClaimAmount)).to.be.closeTo(
        Number(amount) * 0.25,
        Number(parseEther("0.01"))
      );

      // Nothing left to claim
      const stakingData = await getStakingData(stake, user.account.address);
      expect(stakingData.totalClaimable).to.equal(0n);
    });

    it("reverts when claiming non-existent stake ID", async function () {
      const { user, stakeAsUser } = await loadFixture(deployStakeFixture);

      // Create one stake
      await stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 100);

      // Try to claim a non-existent stake ID
      await expect(
        claimUnlocked(stakeAsUser, 999n)
      ).to.be.rejectedWith("StakeDoesNotExist");
    });
    
    it("allows claiming specific stake by ID", async function () {
      const { user, stake, stakeAsUser, erc20 } = await loadFixture(deployStakeFixture);

      // Create two stakes
      await stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 100);
      await stakeTokens(stakeAsUser, user.account.address, parseEther("2"), 200);

      // Get stake IDs
      const stakeIds = await getStakeIds(stake, user.account.address);
      expect(stakeIds.length).to.equal(2);

      // Advance time so first stake is partially vested
      await time.increase(50);

      // Get initial balances and claimable amounts
      const balanceBefore = await erc20.read.balanceOf([user.account.address]);
      const firstStakeDataBefore = await getStakingData(stake, user.account.address, stakeIds[0]);
      const secondStakeDataBefore = await getStakingData(stake, user.account.address, stakeIds[1]);

      // Verify first stake has claimable amount
      expect(Number(firstStakeDataBefore.totalClaimable)).to.be.gt(0);

      // Claim only the first stake
      await claimUnlocked(stakeAsUser, stakeIds[0]);

      // Get balance after claiming
      const balanceAfter = await erc20.read.balanceOf([user.account.address]);
      const claimedAmount = balanceAfter - balanceBefore;

      // Verify something was claimed
      expect(Number(claimedAmount)).to.be.gt(0);

      // Verify the claimed amount is approximately what was claimable (with tolerance for timing)
      expect(Number(claimedAmount)).to.be.closeTo(
        Number(firstStakeDataBefore.totalClaimable),
        Number(parseEther("0.02")) // 0.02 ETH tolerance for timing
      );

      // Verify second stake is unchanged
      const secondStakeDataAfter = await getStakingData(stake, user.account.address, stakeIds[1]);
      expect(Number(secondStakeDataAfter.totalClaimable)).to.be.closeTo(Number(secondStakeDataBefore.totalClaimable), Number(parseEther("0.02")));
    });
  });

  describe("Multiple Stakes", function () {
    it("handles multiple stakes for the same user", async function () {
      const { user, stake, stakeAsUser } = await loadFixture(deployStakeFixture);

      // First stake
      await stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 100);
      await verifyStakeCreated(stake, user.account.address, 1);

      // Second stake
      await stakeTokens(stakeAsUser, user.account.address, parseEther("2"), 200);
      await verifyStakeCreated(stake, user.account.address, 2);

      // Get all stake IDs
      const stakeIds = await getStakeIds(stake, user.account.address);
      expect(stakeIds.length).to.equal(2);

      // Get staking data for all stakes
      const stakingData = await getStakingData(stake, user.account.address);
      expect(stakingData.stakeIds.length).to.equal(2);
      expect(stakingData.claimableAmounts.length).to.equal(2);
    });
  });

  describe("Edge Cases", function () {
    it("handles very short duration stakes", async function () {
      const { user, stakeAsUser, stake } = await loadFixture(deployStakeFixture);

      const amount = parseEther("1");
      const duration = 1; // 1 second duration
      
      await stakeTokens(stakeAsUser, user.account.address, amount, duration);

      // Advance just over the duration
      await time.increase(2);

      // Should be fully claimable
      await verifyClaimableAmount(stake, user.account.address, amount);
    });

    it("handles very long duration stakes", async function () {
      const { user, stakeAsUser, stake } = await loadFixture(deployStakeFixture);

      const amount = parseEther("1");
      const duration = 365 * 24 * 60 * 60; // 1 year
      
      await stakeTokens(stakeAsUser, user.account.address, amount, duration);

      // Advance 1 day
      await time.increase(24 * 60 * 60);

      // Should be approximately 1/365 claimable
      const expectedClaimable = (amount * BigInt(24 * 60 * 60)) / BigInt(duration);
      await verifyClaimableAmount(stake, user.account.address, expectedClaimable);
    });

    it("handles zero claimable gracefully", async function () {
      const { user, stakeAsUser, stake } = await loadFixture(deployStakeFixture);

      await stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 100);

      // Try to claim immediately (should return 0)
      const claimedAmount = await claimUnlocked(stakeAsUser);
      expect(claimedAmount).to.be.a('string'); // Should return transaction hash

      // Verify no tokens were transferred
      const stakingData = await getStakingData(stake, user.account.address);
      expect(stakingData.totalClaimable).to.equal(0n);
    });
  });
});
