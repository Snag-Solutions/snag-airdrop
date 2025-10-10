import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { expect } from "chai";
import {
  keccak256,
  parseEther,
  getAddress,
  encodePacked,
  toBytes,
} from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

type InitParams = {
  admin: `0x${string}`;
  root: `0x${string}`;
  asset: `0x${string}`;
  staking: `0x${string}`;
  maxBonus: bigint;
  minLockupDuration: number;
  minLockupDurationForMultiplier: number;
  multiplier: bigint;
};

type InitFeeConfig = {
  priceFeed: `0x${string}`;
  maxPriceAge: number;
  protocolTreasury: `0x${string}`;
  protocolOverflow: `0x${string}`;
  partnerOverflow: `0x${string}`;
  feeClaimUsdCents: bigint;
  feeStakeUsdCents: bigint;
  feeCapUsdCents: bigint;
  overflowMode: number;
  protocolTokenShareBips: number;
};

describe("Claim + TimelockStake integration", function () {
  it("staking pulls via allowance; balances and bonus accounted", async function () {
    const [deployer, partnerAdmin, user, protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
      await hre.viem.getWalletClients();

    const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
    const timelock = await hre.viem.deployContract("TimelockStake", [erc20.address]);
    const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
    const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

    const allocation = parseEther("100");
    const list: [`0x${string}`, bigint][] = [[user.account.address, allocation]];
    const tree = StandardMerkleTree.of(list, ["address", "uint256"]);
    const root = tree.root as `0x${string}`;

    const multiplier = 1000n; // 10%
    const ip: InitParams = {
      admin: partnerAdmin.account.address,
      root,
      asset: erc20.address,
      staking: timelock.address,
      maxBonus: parseEther("1000"),
      minLockupDuration: 1,
      minLockupDurationForMultiplier: 60,
      multiplier,
    };
    const cfg: InitFeeConfig = {
      priceFeed: feed.address,
      maxPriceAge: 3600,
      protocolTreasury: protocolTreasury.account.address,
      protocolOverflow: protocolOverflow.account.address,
      partnerOverflow: overflowPartner.account.address,
      feeClaimUsdCents: 100n,
      feeStakeUsdCents: 200n,
      feeCapUsdCents: 1000n,
      overflowMode: 0,
      protocolTokenShareBips: 100,
    };

    const salt = keccak256(toBytes("salt-timelock-stake"));
    await factory.write.deployClaim([ip, cfg, salt]);
    const bytecode = (await hre.artifacts.readArtifact("SnagAirdropV2Claim")).bytecode as `0x${string}`;
    const initCodeHash = keccak256(bytecode);
    const compute = (f: `0x${string}`, s: `0x${string}`, h: `0x${string}`) => {
      const packed = encodePacked(["bytes1", "address", "bytes32", "bytes32"], ["0xff", f, s, h]);
      const k = keccak256(packed);
      return getAddress(("0x" + k.slice(26)) as `0x${string}`);
    };
    const claimAddr = compute(factory.address, salt, initCodeHash);
    const claim = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr);

    // Fund and unpause
    const erc20AsDeployer = await hre.viem.getContractAt("MockERC20", erc20.address, { client: { wallet: deployer } });
    await erc20AsDeployer.write.transfer([claim.address, parseEther("1000")]);
    await (await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: partnerAdmin } }))
      .write.unpause();

    // Allowance must be set to timelock
    const max = (1n << 256n) - 1n;
    const allowanceBefore = await erc20.read.allowance([claim.address, timelock.address]);
    expect(allowanceBefore).to.equal(max);

    // Prepare claim
    const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
    const me = entries.find(([, v]) => v[0] === user.account.address)!;
    const proof = tree.getProof(me[1]) as `0x${string}`[];
    const opts = {
      optionId: keccak256(toBytes("stake-100-tl")),
      multiplier,
      percentageToClaim: 0,
      percentageToStake: 10_000,
      lockupPeriod: 120,
    } as const;
    const feeWei = await claim.read.validateClaimOptions([opts]);

    // Execute
    const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
    const sig = await (async () => {
      const domain = { name: "SnagAirdropClaim", version: "1", chainId: await user.getChainId(), verifyingContract: claim.address };
      const types = {
        ClaimRequest: [
          { name: "claimAddress", type: "address" },
          { name: "beneficiary", type: "address" },
          { name: "totalAllocation", type: "uint256" },
          { name: "percentageToClaim", type: "uint16" },
          { name: "percentageToStake", type: "uint16" },
          { name: "lockupPeriod", type: "uint32" },
          { name: "optionId", type: "bytes32" },
          { name: "multiplier", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      } as const;
      const message = {
        claimAddress: claim.address,
        beneficiary: user.account.address,
        totalAllocation: allocation,
        percentageToClaim: 0,
        percentageToStake: 10_000,
        lockupPeriod: 120,
        optionId: opts.optionId,
        multiplier,
        nonce: keccak256(toBytes('nonce-timelock-1')),
      } as const;
      return user.signTypedData({ account: user.account, domain, types, primaryType: "ClaimRequest", message });
    })();

    const claimBalBefore = await erc20.read.balanceOf([claim.address]);
    const stakeBalBefore = await erc20.read.balanceOf([timelock.address]);
    await asUser.write.claimFor([user.account.address, proof, allocation, opts, keccak256(toBytes('nonce-timelock-1')), sig], { value: feeWei });
    const claimBalAfter = await erc20.read.balanceOf([claim.address]);
    const stakeBalAfter = await erc20.read.balanceOf([timelock.address]);
    const deltaClaim = claimBalBefore - claimBalAfter;
    const deltaStake = stakeBalAfter - stakeBalBefore;

    const expectedToStake = allocation + allocation / 10n; // stake + 10% bonus
    expect(deltaClaim).to.equal(expectedToStake);
    expect(deltaStake).to.equal(expectedToStake);
  });

  it("multiple positions: two stakes, different maturities; claim(0) claims matured only", async function () {
    const [deployer, partnerAdmin, user, protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
      await hre.viem.getWalletClients();

    const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
    const timelock = await hre.viem.deployContract("TimelockStake", [erc20.address]);
    const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
    const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

    const allocation = parseEther("100");
    const list: [`0x${string}`, bigint][] = [[user.account.address, allocation]];
    const tree = StandardMerkleTree.of(list, ["address", "uint256"]);
    const root = tree.root as `0x${string}`;

    const multiplier = 0n; // disable bonus to simplify amounts
    const ip: InitParams = {
      admin: partnerAdmin.account.address,
      root,
      asset: erc20.address,
      staking: timelock.address,
      maxBonus: parseEther("1000"),
      minLockupDuration: 1,
      minLockupDurationForMultiplier: 60,
      multiplier,
    };
    const cfg: InitFeeConfig = {
      priceFeed: feed.address,
      maxPriceAge: 3600,
      protocolTreasury: protocolTreasury.account.address,
      protocolOverflow: protocolOverflow.account.address,
      partnerOverflow: overflowPartner.account.address,
      feeClaimUsdCents: 0n,
      feeStakeUsdCents: 0n,
      feeCapUsdCents: 10_000n,
      overflowMode: 0,
      protocolTokenShareBips: 0,
    };

    const salt = keccak256(toBytes("salt-timelock-multi"));
    await factory.write.deployClaim([ip, cfg, salt]);
    const bytecode = (await hre.artifacts.readArtifact("SnagAirdropV2Claim")).bytecode as `0x${string}`;
    const initCodeHash = keccak256(bytecode);
    const compute = (f: `0x${string}`, s: `0x${string}`, h: `0x${string}`) => {
      const packed = encodePacked(["bytes1", "address", "bytes32", "bytes32"], ["0xff", f, s, h]);
      const k = keccak256(packed);
      return getAddress(("0x" + k.slice(26)) as `0x${string}`);
    };
    const claimAddr = compute(factory.address, salt, initCodeHash);
    const claim = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr);

    const erc20AsDeployer = await hre.viem.getContractAt("MockERC20", erc20.address, { client: { wallet: deployer } });
    await erc20AsDeployer.write.transfer([claim.address, parseEther("1000")]);
    await (await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: partnerAdmin } }))
      .write.unpause();

    // Build proof
    const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
    const me = entries.find(([, v]) => v[0] === user.account.address)!;
    const proof = tree.getProof(me[1]) as `0x${string}`[];

    // Helper to sign
    async function sign(opts: any): Promise<`0x${string}`> {
      const domain = { name: "SnagAirdropClaim", version: "1", chainId: await user.getChainId(), verifyingContract: claim.address };
    const types = {
        ClaimRequest: [
          { name: "claimAddress", type: "address" },
          { name: "beneficiary", type: "address" },
          { name: "totalAllocation", type: "uint256" },
          { name: "percentageToClaim", type: "uint16" },
          { name: "percentageToStake", type: "uint16" },
          { name: "lockupPeriod", type: "uint32" },
          { name: "optionId", type: "bytes32" },
          { name: "multiplier", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      } as const;
      const message = {
        claimAddress: claim.address,
        beneficiary: user.account.address,
        totalAllocation: allocation,
        percentageToClaim: 0,
        percentageToStake: 10_000,
        lockupPeriod: opts.lockupPeriod,
        optionId: keccak256(toBytes(opts.optionId)),
        multiplier,
        nonce: keccak256(toBytes('nonce-timelock-1')),
      } as const;
      return user.signTypedData({ account: user.account, domain, types, primaryType: "ClaimRequest", message });
    }

    const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });

    // First stake: 50s lock
    const opts1 = { optionId: "first", lockupPeriod: 50 } as const;
    await asUser.write.claimFor(
      [user.account.address, proof, allocation, {
        optionId: keccak256(toBytes(opts1.optionId)), multiplier, percentageToClaim: 0, percentageToStake: 10_000, lockupPeriod: opts1.lockupPeriod
      }, keccak256(toBytes('nonce-timelock-1')), await sign(opts1)],
      { value: 0n }
    );

    // Second stake: 200s lock (new salt to redeploy? Not needed; we call same claim once per address; but contract prevents double claims)
    // The claim contract prevents multiple claims per beneficiary. To simulate multiple positions, we use a new airdrop instance.
    const salt2 = keccak256(toBytes("salt-timelock-multi-2"));
    await factory.write.deployClaim([{ ...ip }, cfg, salt2]);
    const claimAddr2 = compute(factory.address, salt2, initCodeHash);
    const claim2 = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr2);
    await erc20AsDeployer.write.transfer([claim2.address, parseEther("1000")]);
    await (await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr2, { client: { wallet: partnerAdmin } })).write.unpause();
    const asUser2 = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr2, { client: { wallet: user } });
    const opts2 = { optionId: "second", lockupPeriod: 200 } as const;
    const tree2 = tree; // same allocation
    const proof2 = proof;
    await asUser2.write.claimFor(
      [user.account.address, proof2, allocation, {
        optionId: keccak256(toBytes(opts2.optionId)), multiplier, percentageToClaim: 0, percentageToStake: 10_000, lockupPeriod: opts2.lockupPeriod
      }, keccak256(toBytes('nonce-timelock-3')), await (async () => {
        const domain = { name: "SnagAirdropClaim", version: "1", chainId: await user.getChainId(), verifyingContract: claimAddr2 };
        const types = {
          ClaimRequest: [
            { name: "claimAddress", type: "address" },
            { name: "beneficiary", type: "address" },
            { name: "totalAllocation", type: "uint256" },
            { name: "percentageToClaim", type: "uint16" },
            { name: "percentageToStake", type: "uint16" },
            { name: "lockupPeriod", type: "uint32" },
            { name: "optionId", type: "bytes32" },
            { name: "multiplier", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        } as const;
        const message = {
          claimAddress: claimAddr2 as `0x${string}`,
          beneficiary: user.account.address,
          totalAllocation: allocation,
          percentageToClaim: 0,
          percentageToStake: 10_000,
          lockupPeriod: opts2.lockupPeriod,
          optionId: keccak256(toBytes(opts2.optionId)),
          multiplier,
          nonce: keccak256(toBytes('nonce-timelock-3')),
        } as const;
        return user.signTypedData({ account: user.account, domain, types, primaryType: "ClaimRequest", message });
      })()],
      { value: 0n }
    );

    // Verify two stakes exist on TimelockStake
    const ids = await timelock.read.getStakeIds([user.account.address]);
    expect(ids.length).to.equal(2);

    // Before maturity of second, only first is claimable after 60s
    await time.increase(60);
    const [idsA, amtsA] = await timelock.read.claimable([0n, user.account.address]);
    const totalA = amtsA.reduce((a: bigint, b: bigint) => a + b, 0n);
    expect(totalA).to.equal(allocation); // first stake matured (100% of allocation); second still locked

    // claim(0) pulls only matured stake
    const balBefore = await erc20.read.balanceOf([user.account.address]);
    const timelockAsUser = await hre.viem.getContractAt("TimelockStake", timelock.address, { client: { wallet: user } });
    await timelockAsUser.write.claim([0n]);
    const balAfter = await erc20.read.balanceOf([user.account.address]);
    expect(balAfter - balBefore).to.equal(allocation);

    // After enough time, second matures too
    await time.increase(200);
    const balBefore2 = await erc20.read.balanceOf([user.account.address]);
    await timelockAsUser.write.claim([0n]);
    const balAfter2 = await erc20.read.balanceOf([user.account.address]);
    expect(balAfter2 - balBefore2).to.equal(allocation);
  });
});
