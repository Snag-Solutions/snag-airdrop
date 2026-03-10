import {
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import hre from "hardhat";
import { expect } from "chai";
import {
  keccak256,
  parseEther,
  getAddress,
  zeroAddress,
  encodePacked,
  toBytes,
} from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

type ClaimOptions = {
  optionId: `0x${string}`;
  multiplier: bigint;
  percentageToClaim: number;
  percentageToStake: number;
  lockupPeriod: number;
};

type InitParams = {
  admin: `0x${string}`;
  root: `0x${string}`;
  asset: `0x${string}`;
  staking: `0x${string}`;
  maxBonus: bigint;
  minLockupDuration: number;
  minLockupDurationForMultiplier: number;
  multiplier: bigint;
  minPercentageToStake: number;
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

async function makeClaimSignature(
  signer: any,
  claimAddress: `0x${string}`,
  beneficiary: `0x${string}`,
  totalAllocation: bigint,
  opts: ClaimOptions,
  nonce: `0x${string}`
): Promise<`0x${string}`> {
  const domain = {
    name: "SnagAirdropClaim",
    version: "1",
    chainId: await signer.getChainId(),
    verifyingContract: claimAddress,
  };
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
    claimAddress,
    beneficiary,
    totalAllocation,
    percentageToClaim: opts.percentageToClaim,
    percentageToStake: opts.percentageToStake,
    lockupPeriod: opts.lockupPeriod,
    optionId: opts.optionId,
    multiplier: opts.multiplier,
    nonce,
  };
  return signer.signTypedData({
    account: signer.account!,
    domain,
    types,
    primaryType: "ClaimRequest",
    message,
  });
}

function computeCreate2Address(
  factoryAddr: `0x${string}`,
  saltHex: `0x${string}`,
  initCodeHash: `0x${string}`
): `0x${string}` {
  const packed = encodePacked(
    ["bytes1", "address", "bytes32", "bytes32"],
    ["0xff", factoryAddr, saltHex, initCodeHash]
  );
  const h = keccak256(packed);
  return getAddress(`0x${h.slice(26)}`);
}

/* -------------------------------------------------------------------------- */
/*                          Fixture: forced 85% stake                         */
/* -------------------------------------------------------------------------- */

async function deployForcedStakeFixture() {
  const [deployer, partnerAdmin, user, protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
    await hre.viem.getWalletClients();

  const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
  const linearStake = await hre.viem.deployContract("LinearStake", [erc20.address]);
  const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
  const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

  const allocation = parseEther("100");
  const list: [`0x${string}`, bigint][] = [
    [user.account.address, allocation],
    [partnerAdmin.account.address, parseEther("50")],
  ];
  const tree = StandardMerkleTree.of(list, ["address", "uint256"]);
  const root = tree.root as `0x${string}`;

  const multiplier = 1000n; // 10% bonus
  const ip: InitParams = {
    admin: partnerAdmin.account.address,
    root,
    asset: erc20.address,
    staking: linearStake.address,
    maxBonus: parseEther("1000"),
    minLockupDuration: 60,
    minLockupDurationForMultiplier: 120,
    multiplier,
    minPercentageToStake: 8500, // force 85% staked
  };

  const cfg: InitFeeConfig = {
    priceFeed: feed.address,
    maxPriceAge: 3600,
    protocolTreasury: protocolTreasury.account.address,
    protocolOverflow: protocolOverflow.account.address,
    partnerOverflow: overflowPartner.account.address,
    feeClaimUsdCents: 100n,
    feeStakeUsdCents: 200n,
    feeCapUsdCents: 10_000n,
    overflowMode: 0,
    protocolTokenShareBips: 100,
  };

  const salt = keccak256(toBytes("salt-forced-stake"));
  await factory.write.deployClaim([ip, cfg, salt]);
  const bytecode = (await hre.artifacts.readArtifact("SnagAirdropV2Claim")).bytecode as `0x${string}`;
  const initCodeHash = keccak256(bytecode);
  const claimAddress = computeCreate2Address(factory.address, salt, initCodeHash);
  const claim = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddress);

  await erc20.write.transfer([claim.address, parseEther("10000")]);
  const claimAsAdmin = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, {
    client: { wallet: partnerAdmin },
  });
  await claimAsAdmin.write.unpause();

  return {
    deployer,
    partnerAdmin,
    user,
    protocolAdmin,
    overflowPartner,
    protocolTreasury,
    protocolOverflow,
    erc20,
    linearStake,
    feed,
    factory,
    claim,
    claimAsAdmin,
    root,
    tree,
    allocation,
    multiplier,
    cfg,
    ip,
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Tests                                    */
/* -------------------------------------------------------------------------- */

describe("Claim: forced stake percentage (minPercentageToStake)", () => {
  // ---- Initialization ----

  it("stores minPercentageToStake correctly after initialization", async () => {
    const { claim } = await loadFixture(deployForcedStakeFixture);
    expect(await claim.read.minPercentageToStake()).to.equal(8500);
  });

  it("deploy with minPercentageToStake=0 succeeds (backward compat)", async () => {
    const [deployer, partnerAdmin, , protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
      await hre.viem.getWalletClients();
    const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
    const stake = await hre.viem.deployContract("MockStake");
    const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
    const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

    const ip: InitParams = {
      admin: partnerAdmin.account.address,
      root: keccak256(toBytes("root")),
      asset: erc20.address,
      staking: stake.address,
      maxBonus: 0n,
      minLockupDuration: 0,
      minLockupDurationForMultiplier: 0,
      multiplier: 0n,
      minPercentageToStake: 0,
    };
    const cfg: InitFeeConfig = {
      priceFeed: feed.address,
      maxPriceAge: 3600,
      protocolTreasury: protocolTreasury.account.address,
      protocolOverflow: protocolOverflow.account.address,
      partnerOverflow: overflowPartner.account.address,
      feeClaimUsdCents: 0n,
      feeStakeUsdCents: 0n,
      feeCapUsdCents: 0n,
      overflowMode: 0,
      protocolTokenShareBips: 0,
    };
    const salt = keccak256(toBytes("salt-compat"));
    await expect(factory.write.deployClaim([ip, cfg, salt])).to.not.be.rejected;
  });

  it("reverts init when minPercentageToStake > 0 but staking address is zero", async () => {
    const [deployer, partnerAdmin, , protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
      await hre.viem.getWalletClients();
    const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
    const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
    const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

    const ip: InitParams = {
      admin: partnerAdmin.account.address,
      root: keccak256(toBytes("root")),
      asset: erc20.address,
      staking: zeroAddress,
      maxBonus: 0n,
      minLockupDuration: 0,
      minLockupDurationForMultiplier: 0,
      multiplier: 0n,
      minPercentageToStake: 5000,
    };
    const cfg: InitFeeConfig = {
      priceFeed: feed.address,
      maxPriceAge: 3600,
      protocolTreasury: protocolTreasury.account.address,
      protocolOverflow: protocolOverflow.account.address,
      partnerOverflow: overflowPartner.account.address,
      feeClaimUsdCents: 0n,
      feeStakeUsdCents: 0n,
      feeCapUsdCents: 0n,
      overflowMode: 0,
      protocolTokenShareBips: 0,
    };
    const salt = keccak256(toBytes("salt-no-staking"));
    await expect(factory.write.deployClaim([ip, cfg, salt])).to.be.rejectedWith("NoStaking");
  });

  it("reverts init when minPercentageToStake > 10_000", async () => {
    const [deployer, partnerAdmin, , protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
      await hre.viem.getWalletClients();
    const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
    const stake = await hre.viem.deployContract("MockStake");
    const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
    const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

    const ip: InitParams = {
      admin: partnerAdmin.account.address,
      root: keccak256(toBytes("root")),
      asset: erc20.address,
      staking: stake.address,
      maxBonus: 0n,
      minLockupDuration: 0,
      minLockupDurationForMultiplier: 0,
      multiplier: 0n,
      minPercentageToStake: 10_001,
    };
    const cfg: InitFeeConfig = {
      priceFeed: feed.address,
      maxPriceAge: 3600,
      protocolTreasury: protocolTreasury.account.address,
      protocolOverflow: protocolOverflow.account.address,
      partnerOverflow: overflowPartner.account.address,
      feeClaimUsdCents: 0n,
      feeStakeUsdCents: 0n,
      feeCapUsdCents: 0n,
      overflowMode: 0,
      protocolTokenShareBips: 0,
    };
    const salt = keccak256(toBytes("salt-overflow"));
    await expect(factory.write.deployClaim([ip, cfg, salt])).to.be.rejectedWith("PctSumExceeded");
  });

  // ---- validateClaimOptions ----

  it("validateClaimOptions reverts when percentageToStake < minPercentageToStake", async () => {
    const { claim, multiplier } = await loadFixture(deployForcedStakeFixture);
    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("too-low")),
      multiplier,
      percentageToClaim: 2000,
      percentageToStake: 8000, // < 8500
      lockupPeriod: 120,
    };
    await expect(claim.read.validateClaimOptions([opts])).to.be.rejectedWith("StakePercentageTooLow");
  });

  it("validateClaimOptions passes when percentageToStake == minPercentageToStake", async () => {
    const { claim, multiplier } = await loadFixture(deployForcedStakeFixture);
    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("exact")),
      multiplier,
      percentageToClaim: 1500,
      percentageToStake: 8500,
      lockupPeriod: 120,
    };
    await expect(claim.read.validateClaimOptions([opts])).to.not.be.rejected;
  });

  it("validateClaimOptions passes when percentageToStake > minPercentageToStake", async () => {
    const { claim, multiplier } = await loadFixture(deployForcedStakeFixture);
    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("above")),
      multiplier,
      percentageToClaim: 0,
      percentageToStake: 10_000,
      lockupPeriod: 120,
    };
    await expect(claim.read.validateClaimOptions([opts])).to.not.be.rejected;
  });

  // ---- claimFor enforcement ----

  it("claimFor reverts when percentageToStake < minPercentageToStake", async () => {
    const { claim, user, tree, allocation, multiplier } = await loadFixture(deployForcedStakeFixture);
    const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
    const me = entries.find(([, v]) => v[0] === user.account.address)!;
    const proof = tree.getProof(me[1]) as `0x${string}`[];

    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("force-fail")),
      multiplier,
      percentageToClaim: 2000,
      percentageToStake: 8000, // 80% < 85%
      lockupPeriod: 120,
    };
    const nonce = keccak256(toBytes("nonce-force-fail"));
    const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);
    const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
    await expect(
      asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig])
    ).to.be.rejectedWith("StakePercentageTooLow");
  });

  it("claimFor succeeds at exact minPercentageToStake boundary (85% stake, 15% claim)", async () => {
    const { claim, erc20, linearStake, user, tree, allocation, multiplier } =
      await loadFixture(deployForcedStakeFixture);

    const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
    const me = entries.find(([, v]) => v[0] === user.account.address)!;
    const proof = tree.getProof(me[1]) as `0x${string}`[];

    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("exact-boundary")),
      multiplier,
      percentageToClaim: 1500, // 15%
      percentageToStake: 8500, // 85%
      lockupPeriod: 120,
    };
    const feeWei = await claim.read.validateClaimOptions([opts]);
    const nonce = keccak256(toBytes("nonce-exact"));
    const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);

    const userBefore = await erc20.read.balanceOf([user.account.address]);
    const stakeBefore = await erc20.read.balanceOf([linearStake.address]);

    const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
    await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig], { value: feeWei });

    const userAfter = await erc20.read.balanceOf([user.account.address]);
    const stakeAfter = await erc20.read.balanceOf([linearStake.address]);

    const expectedClaim = (allocation * 1500n) / 10_000n; // 15 ETH
    const expectedStake = (allocation * 8500n) / 10_000n; // 85 ETH
    const expectedBonus = (expectedStake * multiplier) / 10_000n; // 8.5 ETH
    const expectedToStake = expectedStake + expectedBonus; // 93.5 ETH

    expect(userAfter - userBefore).to.equal(expectedClaim);
    expect(stakeAfter - stakeBefore).to.equal(expectedToStake);

    // Verify on-chain tracking
    expect(await claim.read.totalClaimed()).to.equal(expectedClaim);
    expect(await claim.read.totalStaked()).to.equal(expectedStake);
    expect(await claim.read.totalBonusTokens()).to.equal(expectedBonus);
    expect(await claim.read.claimedAmount([user.account.address])).to.equal(allocation);
  });

  it("claimFor succeeds with 100% stake when minPercentageToStake is set", async () => {
    const { claim, erc20, linearStake, user, tree, allocation, multiplier } =
      await loadFixture(deployForcedStakeFixture);

    const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
    const me = entries.find(([, v]) => v[0] === user.account.address)!;
    const proof = tree.getProof(me[1]) as `0x${string}`[];

    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("full-stake")),
      multiplier,
      percentageToClaim: 0,
      percentageToStake: 10_000,
      lockupPeriod: 120,
    };
    const feeWei = await claim.read.validateClaimOptions([opts]);
    const nonce = keccak256(toBytes("nonce-full-stake"));
    const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);

    const userBefore = await erc20.read.balanceOf([user.account.address]);
    const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
    await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig], { value: feeWei });

    // User gets nothing directly
    const userAfter = await erc20.read.balanceOf([user.account.address]);
    expect(userAfter - userBefore).to.equal(0n);

    // Everything staked
    expect(await claim.read.totalStaked()).to.equal(allocation);
  });

  // ---- Edge: minPercentageToStake = 10_000 (force 100% stake) ----

  it("minPercentageToStake=10_000 forces 100% stake; 0% claim attempt reverts", async () => {
    const [deployer, partnerAdmin, user, protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
      await hre.viem.getWalletClients();

    const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
    const linearStake = await hre.viem.deployContract("LinearStake", [erc20.address]);
    const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
    const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

    const allocation = parseEther("100");
    const list: [`0x${string}`, bigint][] = [[user.account.address, allocation]];
    const tree = StandardMerkleTree.of(list, ["address", "uint256"]);
    const root = tree.root as `0x${string}`;

    const ip: InitParams = {
      admin: partnerAdmin.account.address,
      root,
      asset: erc20.address,
      staking: linearStake.address,
      maxBonus: parseEther("1000"),
      minLockupDuration: 60,
      minLockupDurationForMultiplier: 120,
      multiplier: 0n,
      minPercentageToStake: 10_000, // force 100%
    };
    const cfg: InitFeeConfig = {
      priceFeed: feed.address,
      maxPriceAge: 3600,
      protocolTreasury: protocolTreasury.account.address,
      protocolOverflow: protocolOverflow.account.address,
      partnerOverflow: overflowPartner.account.address,
      feeClaimUsdCents: 0n,
      feeStakeUsdCents: 0n,
      feeCapUsdCents: 0n,
      overflowMode: 0,
      protocolTokenShareBips: 0,
    };
    const salt = keccak256(toBytes("salt-force-100"));
    await factory.write.deployClaim([ip, cfg, salt]);
    const bytecode = (await hre.artifacts.readArtifact("SnagAirdropV2Claim")).bytecode as `0x${string}`;
    const initCodeHash = keccak256(bytecode);
    const claimAddr = computeCreate2Address(factory.address, salt, initCodeHash);
    const claim = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr);

    await erc20.write.transfer([claim.address, parseEther("10000")]);
    await (await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr, { client: { wallet: partnerAdmin } }))
      .write.unpause();

    // Attempt 50/50 split — must fail
    const badOpts: ClaimOptions = {
      optionId: keccak256(toBytes("half-half")),
      multiplier: 0n,
      percentageToClaim: 5000,
      percentageToStake: 5000,
      lockupPeriod: 120,
    };
    await expect(claim.read.validateClaimOptions([badOpts])).to.be.rejectedWith("StakePercentageTooLow");

    // 100% stake succeeds
    const goodOpts: ClaimOptions = {
      optionId: keccak256(toBytes("all-stake")),
      multiplier: 0n,
      percentageToClaim: 0,
      percentageToStake: 10_000,
      lockupPeriod: 120,
    };
    await expect(claim.read.validateClaimOptions([goodOpts])).to.not.be.rejected;

    const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
    const me = entries.find(([, v]) => v[0] === user.account.address)!;
    const proof = tree.getProof(me[1]) as `0x${string}`[];
    const nonce = keccak256(toBytes("nonce-force-100"));
    const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, goodOpts, nonce);
    const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr, { client: { wallet: user } });
    await expect(
      asUser.write.claimFor([user.account.address, proof, allocation, goodOpts, nonce, sig])
    ).to.not.be.rejected;

    expect(await claim.read.totalStaked()).to.equal(allocation);
    expect(await claim.read.totalClaimed()).to.equal(0n);
  });

  // ---- Bonus + forced stake ----

  it("forced stake with bonus multiplier: bonus calculated on staked portion", async () => {
    const { claim, erc20, linearStake, user, tree, allocation, multiplier } =
      await loadFixture(deployForcedStakeFixture);

    const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
    const me = entries.find(([, v]) => v[0] === user.account.address)!;
    const proof = tree.getProof(me[1]) as `0x${string}`[];

    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("bonus-forced")),
      multiplier,
      percentageToClaim: 1000, // 10%
      percentageToStake: 9000, // 90% (above 85% min)
      lockupPeriod: 120,
    };
    const feeWei = await claim.read.validateClaimOptions([opts]);
    const nonce = keccak256(toBytes("nonce-bonus-forced"));
    const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);

    const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
    await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig], { value: feeWei });

    const expectedStake = (allocation * 9000n) / 10_000n; // 90 ETH
    const expectedBonus = (expectedStake * multiplier) / 10_000n; // 9 ETH

    expect(await claim.read.totalBonusTokens()).to.equal(expectedBonus);
    expect(await claim.read.totalStaked()).to.equal(expectedStake);
  });

  // ---- Protocol token share with forced stake ----

  it("protocol token share accounting correct with forced stake", async () => {
    const { claim, user, tree, allocation, multiplier } =
      await loadFixture(deployForcedStakeFixture);

    const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
    const me = entries.find(([, v]) => v[0] === user.account.address)!;
    const proof = tree.getProof(me[1]) as `0x${string}`[];

    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("proto-share")),
      multiplier,
      percentageToClaim: 1500,
      percentageToStake: 8500,
      lockupPeriod: 120,
    };
    const feeWei = await claim.read.validateClaimOptions([opts]);
    const nonce = keccak256(toBytes("nonce-proto"));
    const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);

    const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
    await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig], { value: feeWei });

    const amountClaimed = (allocation * 1500n) / 10_000n;
    const amountStaked = (allocation * 8500n) / 10_000n;
    const bonus = (amountStaked * multiplier) / 10_000n;
    const distributed = amountClaimed + amountStaked + bonus;
    const expectedProto = (distributed * 100n + 9999n) / 10000n; // ceil(distributed * 1%)

    expect(await claim.read.protocolAccruedTokens()).to.equal(expectedProto);
  });

  // ---- Forced stake with TimelockStake ----

  it("forced stake works end-to-end with TimelockStake", async () => {
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

    const ip: InitParams = {
      admin: partnerAdmin.account.address,
      root,
      asset: erc20.address,
      staking: timelock.address,
      maxBonus: parseEther("1000"),
      minLockupDuration: 60,
      minLockupDurationForMultiplier: 120,
      multiplier: 0n,
      minPercentageToStake: 8500,
    };
    const cfg: InitFeeConfig = {
      priceFeed: feed.address,
      maxPriceAge: 3600,
      protocolTreasury: protocolTreasury.account.address,
      protocolOverflow: protocolOverflow.account.address,
      partnerOverflow: overflowPartner.account.address,
      feeClaimUsdCents: 0n,
      feeStakeUsdCents: 0n,
      feeCapUsdCents: 0n,
      overflowMode: 0,
      protocolTokenShareBips: 0,
    };
    const salt = keccak256(toBytes("salt-forced-timelock"));
    await factory.write.deployClaim([ip, cfg, salt]);
    const bytecode = (await hre.artifacts.readArtifact("SnagAirdropV2Claim")).bytecode as `0x${string}`;
    const initCodeHash = keccak256(bytecode);
    const claimAddr = computeCreate2Address(factory.address, salt, initCodeHash);
    const claim = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr);

    await erc20.write.transfer([claim.address, parseEther("10000")]);
    await (await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr, { client: { wallet: partnerAdmin } }))
      .write.unpause();

    const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
    const me = entries.find(([, v]) => v[0] === user.account.address)!;
    const proof = tree.getProof(me[1]) as `0x${string}`[];

    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("tl-forced")),
      multiplier: 0n,
      percentageToClaim: 1500,
      percentageToStake: 8500,
      lockupPeriod: 120,
    };
    const nonce = keccak256(toBytes("nonce-tl-forced"));
    const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);

    const userBefore = await erc20.read.balanceOf([user.account.address]);
    const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr, { client: { wallet: user } });
    await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig]);

    const userAfter = await erc20.read.balanceOf([user.account.address]);
    const expectedClaim = (allocation * 1500n) / 10_000n;
    expect(userAfter - userBefore).to.equal(expectedClaim);

    // Verify stake was created in timelock
    const stakeIds = await timelock.read.getStakeIds([user.account.address]);
    expect(stakeIds.length).to.equal(1);

    const expectedStake = (allocation * 8500n) / 10_000n;
    const timelockBal = await erc20.read.balanceOf([timelock.address]);
    expect(timelockBal).to.equal(expectedStake);
  });

  // ---- Just below boundary (off-by-one) ----

  it("rejects percentageToStake that is 1 bip below minPercentageToStake", async () => {
    const { claim, multiplier } = await loadFixture(deployForcedStakeFixture);
    const opts: ClaimOptions = {
      optionId: keccak256(toBytes("off-by-one")),
      multiplier,
      percentageToClaim: 1501,
      percentageToStake: 8499, // exactly 1 bip below 8500
      lockupPeriod: 120,
    };
    await expect(claim.read.validateClaimOptions([opts])).to.be.rejectedWith("StakePercentageTooLow");
  });
});
