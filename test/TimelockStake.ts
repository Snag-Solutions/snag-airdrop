import { time, loadFixture } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { expect } from "chai";
import { parseEther } from "viem";

async function deployStakeFixture() {
  const [deployer, user] = await hre.viem.getWalletClients();

  const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
  const stake = await hre.viem.deployContract("TimelockStake", [erc20.address]);

  // Fund user and approve staking contract
  await erc20.write.transfer([user.account.address, parseEther("1000")]);
  const erc20AsUser = await hre.viem.getContractAt("MockERC20", erc20.address, { client: { wallet: user } });
  await erc20AsUser.write.approve([stake.address, (1n << 256n) - 1n]);

  const stakeAsUser = await hre.viem.getContractAt("TimelockStake", stake.address, { client: { wallet: user } });

  return { deployer, user, erc20, erc20AsUser, stake, stakeAsUser };
}

async function stakeTokens(stakeAsUser: any, staker: `0x${string}`, amount: bigint, duration: number) {
  return stakeAsUser.write.stakeFor([staker, amount, BigInt(duration)]);
}

async function getStakeIds(stake: any, account: `0x${string}`): Promise<bigint[]> {
  return stake.read.getStakeIds([account]);
}

async function getClaimable(stake: any, account: `0x${string}`, stakeId?: bigint): Promise<{ ids: bigint[]; amounts: bigint[]; total: bigint }> {
  const [ids, amts] = await stake.read.claimable([stakeId ?? 0n, account]);
  const total = amts.reduce((acc: bigint, x: bigint) => acc + x, 0n);
  return { ids, amounts: amts, total };
}

async function claimAndDelta(stakeAsUser: any, erc20: any, userAddr: `0x${string}`, stakeId?: bigint): Promise<bigint> {
  const before = await erc20.read.balanceOf([userAddr]);
  await stakeAsUser.write.claim([stakeId ?? 0n]);
  const after = await erc20.read.balanceOf([userAddr]);
  return (after as bigint) - (before as bigint);
}

describe("TimelockStake", function () {
  describe("Staking Validation", function () {
    it("reverts when staking zero amount", async function () {
      const { stakeAsUser, user } = await loadFixture(deployStakeFixture);
      await expect(stakeTokens(stakeAsUser, user.account.address, 0n, 100)).to.be.rejectedWith("AmountMustBePositive");
    });

    it("reverts when staking with zero duration", async function () {
      const { stakeAsUser, user } = await loadFixture(deployStakeFixture);
      await expect(stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 0)).to.be.rejectedWith("DurationMustBePositive");
    });
  });

  describe("Timelock Behavior", function () {
    it("claimable is zero until maturity, then full amount", async function () {
      const { user, stakeAsUser, stake } = await loadFixture(deployStakeFixture);
      const amount = parseEther("1");
      const duration = 100;

      await stakeTokens(stakeAsUser, user.account.address, amount, duration);

      // Immediately after stake
      let data = await getClaimable(stake, user.account.address);
      expect(data.total).to.equal(0n);

      // Just before maturity
      await time.increase(duration - 1);
      data = await getClaimable(stake, user.account.address);
      expect(data.total).to.equal(0n);

      // Reach maturity
      await time.increase(1);
      data = await getClaimable(stake, user.account.address);
      expect(data.total).to.equal(amount);
    });

    it("claim before maturity: specific ID reverts; claim all returns 0", async function () {
      const { user, stakeAsUser, stake, erc20 } = await loadFixture(deployStakeFixture);
      await stakeTokens(stakeAsUser, user.account.address, parseEther("1"), 100);
      const ids = await getStakeIds(stake, user.account.address);
      await expect(stakeAsUser.write.claim([ids[0]])).to.be.rejectedWith("StakeNotMatured");
      const claimed = await claimAndDelta(stakeAsUser, erc20, user.account.address, 0n);
      expect(claimed).to.equal(0n);
    });

    it("claims full amount at/after maturity and prevents double claim", async function () {
      const { user, stakeAsUser, stake, erc20 } = await loadFixture(deployStakeFixture);
      const amount = parseEther("2");
      const duration = 60;
      await stakeTokens(stakeAsUser, user.account.address, amount, duration);
      const ids = await getStakeIds(stake, user.account.address);

      await time.increase(duration);
      const first = await claimAndDelta(stakeAsUser, erc20, user.account.address, ids[0]);
      expect(first).to.equal(amount);

      // No further claimable
      const data = await getClaimable(stake, user.account.address, ids[0]);
      expect(data.total).to.equal(0n);
      await expect(stakeAsUser.write.claim([ids[0]])).to.be.rejectedWith("StakeAlreadyClaimed");
    });
  });

  describe("Multiple Stakes and claim(all)", function () {
    it("claim(0) claims only matured stakes", async function () {
      const { user, stakeAsUser, stake, erc20 } = await loadFixture(deployStakeFixture);
      const a1 = parseEther("1");
      const a2 = parseEther("3");
      await stakeTokens(stakeAsUser, user.account.address, a1, 50);
      await stakeTokens(stakeAsUser, user.account.address, a2, 200);

      // After 60s: first matured, second not
      await time.increase(60);
      const claimed1 = await claimAndDelta(stakeAsUser, erc20, user.account.address, 0n);
      expect(claimed1).to.equal(a1);

      // After total 200s: second matured
      await time.increase(200);
      const claimed2 = await claimAndDelta(stakeAsUser, erc20, user.account.address, 0n);
      expect(claimed2).to.equal(a2);
    });
  });

  describe("Errors and enumeration", function () {
    it("reverts when claiming non-existent stake ID", async function () {
      const { stakeAsUser } = await loadFixture(deployStakeFixture);
      await expect(stakeAsUser.write.claim([999n])).to.be.rejectedWith("StakeDoesNotExist");
    });

    it("claimable for specific non-existent ID returns [id],[0]", async function () {
      const { user, stake } = await loadFixture(deployStakeFixture);
      const [ids, amts] = await stake.read.claimable([123n, user.account.address]);
      expect(ids.length).to.equal(1);
      expect(amts.length).to.equal(1);
      expect(ids[0]).to.equal(123n);
      expect(amts[0]).to.equal(0n);
    });

    it("getStakeIds empty for user with no stakes", async function () {
      const { user, stake } = await loadFixture(deployStakeFixture);
      const ids = await stake.read.getStakeIds([user.account.address]);
      expect(ids.length).to.equal(0);
    });
  });

  describe("ERC165 Interface Support", function () {
    it("supports ERC165 and not random interface", async function () {
      const { stake } = await loadFixture(deployStakeFixture);
      const erc165 = "0x01ffc9a7";
      expect(await stake.read.supportsInterface([erc165])).to.equal(true);
      expect(await stake.read.supportsInterface(["0x12345678"])).to.equal(false);
    });
  });
});

