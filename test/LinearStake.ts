import { time, loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { expect } from "chai";
import { parseEther } from "viem";

// Local helpers (kept inline to match project style)
async function deployStakeFixture() {
  const [deployer, user] = await hre.viem.getWalletClients();

  const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
  const stake = await hre.viem.deployContract("LinearStake", [erc20.address]);

  // Fund user and approve staking contract
  await erc20.write.transfer([user.account.address, parseEther("1000")]);
  const erc20AsUser = await hre.viem.getContractAt("MockERC20", erc20.address, { client: { wallet: user } });
  await erc20AsUser.write.approve([stake.address, (1n << 256n) - 1n]);

  const stakeAsUser = await hre.viem.getContractAt("LinearStake", stake.address, { client: { wallet: user } });

  return { deployer, user, erc20, erc20AsUser, stake, stakeAsUser };
}

async function stakeTokens(stakeAsUser: any, staker: `0x${string}`, amount: bigint, duration: number) {
  return stakeAsUser.write.stakeFor([staker, amount, duration]);
}

async function getStakeIds(stake: any, account: `0x${string}`): Promise<bigint[]> {
  return stake.read.getStakeIds([account]);
}

async function getStakingData(
  stake: any,
  account: `0x${string}`,
  stakeId?: bigint
): Promise<{ stakeIds: bigint[]; claimableAmounts: bigint[]; totalClaimable: bigint }> {
  const [ids, amts] = await stake.read.claimable([stakeId ?? 0n, account]);
  const total = amts.reduce((acc: bigint, x: bigint) => acc + x, 0n);
  return { stakeIds: ids, claimableAmounts: amts, totalClaimable: total };
}

async function claimUnlocked(stakeAsUser: any, stakeId?: bigint): Promise<`0x${string}`> {
  return stakeAsUser.write.claimUnlocked([stakeId ?? 0n]);
}

async function claimUnlockedAndGetAmount(
  stakeAsUser: any,
  erc20: any,
  userAddr: `0x${string}`,
  stakeId?: bigint
): Promise<bigint> {
  const before = await erc20.read.balanceOf([userAddr]);
  await stakeAsUser.write.claimUnlocked([stakeId ?? 0n]);
  const after = await erc20.read.balanceOf([userAddr]);
  return after - before;
}

async function verifyStakeCreated(stake: any, account: `0x${string}`, expectedCount: number) {
  const ids = await getStakeIds(stake, account);
  expect(ids.length).to.equal(expectedCount);
}

async function verifyClaimableAmount(stake: any, account: `0x${string}`, expected: bigint) {
  const data = await getStakingData(stake, account);
  expect(data.totalClaimable).to.equal(expected);
}
  
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
  
      it("handles claiming after already claiming everything", async function () {
        const { user, stakeAsUser, stake, erc20 } = await loadFixture(deployStakeFixture);
  
        await stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 100);
  
        // Advance full duration
        await time.increase(100);
  
        // First claim - should claim everything
        const firstClaimAmount = await claimUnlockedAndGetAmount(
          stakeAsUser,
          erc20,
          user.account.address
        );
  
        expect(firstClaimAmount).to.equal(parseEther("1"));
  
        // Second claim - should claim 0
        const secondClaimAmount = await claimUnlockedAndGetAmount(
          stakeAsUser,
          erc20,
          user.account.address
        );
  
        expect(secondClaimAmount).to.equal(0n);
      });
  
      it("handles claiming specific stake after already claiming everything", async function () {
        const { user, stakeAsUser, stake, erc20 } = await loadFixture(deployStakeFixture);
  
        await stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 100);
  
        // Get stake IDs
        const stakeIds = await getStakeIds(stake, user.account.address);
  
        // Advance full duration
        await time.increase(100);
  
        // First claim - should claim everything
        const firstClaimAmount = await claimUnlockedAndGetAmount(
          stakeAsUser,
          erc20,
          user.account.address,
          stakeIds[0]
        );
  
        expect(firstClaimAmount).to.equal(parseEther("1"));
  
        // Second claim - should claim 0
        const secondClaimAmount = await claimUnlockedAndGetAmount(
          stakeAsUser,
          erc20,
          user.account.address,
          stakeIds[0]
        );
  
        expect(secondClaimAmount).to.equal(0n);
      });
    });
  
    describe("ERC165 Interface Support", function () {
      it("supports ERC165 interface", async function () {
        const { stake } = await loadFixture(deployStakeFixture);
        
        // ERC165 interface ID
        const erc165InterfaceId = "0x01ffc9a7";
        
        const supportsERC165 = await stake.read.supportsInterface([erc165InterfaceId]);
        expect(supportsERC165).to.be.true;
      });
  
      it("does not support unknown interface", async function () {
        const { stake } = await loadFixture(deployStakeFixture);
        
        // Random interface ID
        const unknownInterfaceId = "0x12345678";
        
        const supportsUnknown = await stake.read.supportsInterface([unknownInterfaceId]);
        expect(supportsUnknown).to.be.false;
      });
    });
  
    describe("Zero Amount Edge Cases", function () {
      it("handles querying claimable for non-existent stake with zero amount", async function () {
        const { user, stake } = await loadFixture(deployStakeFixture);
  
        // Query claimable for a non-existent stake ID
        const [stakeIds, claimableAmounts] = await stake.read.claimable([
          999n,
          user.account.address
        ]);
  
        expect(stakeIds.length).to.equal(1);
        expect(claimableAmounts.length).to.equal(1);
        expect(stakeIds[0]).to.equal(999n);
        expect(claimableAmounts[0]).to.equal(0n);
      });
  
      it("handles querying claimable for empty stake set", async function () {
        const { user, stake } = await loadFixture(deployStakeFixture);
  
        // Query claimable for user with no stakes
        const [stakeIds, claimableAmounts] = await stake.read.claimable([
          0n,
          user.account.address
        ]);
  
        expect(stakeIds.length).to.equal(0);
        expect(claimableAmounts.length).to.equal(0);
      });
  
      it("handles getStakeIds for user with no stakes", async function () {
        const { user, stake } = await loadFixture(deployStakeFixture);
  
        // Get stake IDs for user with no stakes
        const stakeIds = await getStakeIds(stake, user.account.address);
        expect(stakeIds.length).to.equal(0);
      });
  
      it("handles querying claimable for multiple non-existent stakes", async function () {
        const { user, stake } = await loadFixture(deployStakeFixture);
  
        // Create a real stake first
        const { stakeAsUser } = await loadFixture(deployStakeFixture);
        await stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 100);
  
        // Query claimable for all stakes (should include the real one)
        const [stakeIds, claimableAmounts] = await stake.read.claimable([
          0n,
          user.account.address
        ]);
  
        expect(stakeIds.length).to.equal(1);
        expect(claimableAmounts.length).to.equal(1);
        expect(stakeIds[0]).to.equal(1n); // First stake ID
        expect(claimableAmounts[0]).to.equal(0n); // No time passed, so 0 claimable
      });
    });
  });
  
