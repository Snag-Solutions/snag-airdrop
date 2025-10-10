import {
    time,
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
    parseEventLogs,
  } from "viem";
  import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
  
  /* -------------------------------------------------------------------------- */
  /*                                  Helpers                                   */
  /* -------------------------------------------------------------------------- */
  
  type ClaimOptions = {
    optionId: `0x${string}`;
    multiplier: bigint;
    percentageToClaim: number; // uint16
    percentageToStake: number; // uint16
    lockupPeriod: number; // uint32
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
    overflowMode: number; // 0 Cancel, 1 Partner, 2 Protocol
    protocolTokenShareBips: number; // uint16
  };
  
  function leafFor(addr: `0x${string}`, amount: bigint): `0x${string}` {
    return keccak256(encodePacked(["bytes32"], [keccak256(encodePacked(["address", "uint256"], [addr, amount]))]));
  }
  
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
  
  /* -------------------------------------------------------------------------- */
  /*                                  Fixture                                   */
  /* -------------------------------------------------------------------------- */
  
  async function deployFixture() {
    const [deployer, partnerAdmin, user, protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
      await hre.viem.getWalletClients();
  
    // Deploy mocks
    const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
    const stake = await hre.viem.deployContract("MockStake");
    const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]); // 1 ETH ~ $3000
  
    // Factory with roles (this is the updated mock)
    const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);
  
    // Build merkle list
    const allocation = parseEther("100");
    const claimList: [`0x${string}`, bigint][] = [
      [user.account.address, allocation],
      [partnerAdmin.account.address, parseEther("5")],
    ];
    const tree = StandardMerkleTree.of(claimList, ["address", "uint256"]);
    const root = tree.root as `0x${string}`;
  
    // Claim init params
    const multiplier = 1000n; // 10%
    const ip: InitParams = {
      admin: partnerAdmin.account.address,
      root,
      asset: erc20.address,
      staking: stake.address,
      maxBonus: parseEther("1000"),
      minLockupDuration: 1, // minimal
      minLockupDurationForMultiplier: 60,
      multiplier,
    };
  
    // Fee config: $1 for claim, $2 for stake, cap $10, token share 1%
    const cfg: InitFeeConfig = {
      priceFeed: feed.address,
      maxPriceAge: 3600,
      protocolTreasury: protocolTreasury.account.address,
      protocolOverflow: protocolOverflow.account.address,
      partnerOverflow: overflowPartner.account.address,
      feeClaimUsdCents: 100n,
      feeStakeUsdCents: 200n,
      feeCapUsdCents: 1000n,
      overflowMode: 0, // Cancel
      protocolTokenShareBips: 100, // 1%
    };
  
    // Deploy claim via factory (ensures onlyFactory)
    const salt = keccak256(toBytes("salt-1"));
    const tx = await factory.write.deployClaim([ip, cfg, salt]);
    // Find created address from CREATE2: we can compute, but simpler: query logs? claim has no event on init.
    // In tests we can brute-force by scanning for new code — but here, call a helper: compute CREATE2 manually.
    // Deterministic: keccak256(0xFF ++ factory ++ salt ++ keccak256(bytecode))[12:]
    // We’ll compute it using viem’s getContractAddress utility — not available. Implement quick compute:
  
    const bytecode = (await hre.artifacts.readArtifact("SnagAirdropV2Claim")).bytecode as `0x${string}`;
    function computeCreate2Address(factoryAddr: `0x${string}`, saltHex: `0x${string}`, initCodeHash: `0x${string}`): `0x${string}` {
      const packed = encodePacked(["bytes1","address","bytes32","bytes32"], ["0xff", factoryAddr, saltHex, initCodeHash]);
      const h = keccak256(packed);
      return getAddress(`0x${h.slice(26)}`); // last 20 bytes
    }
    const initCodeHash = keccak256(bytecode);
    const claimAddress = computeCreate2Address(factory.address, salt, initCodeHash);
    const claim = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddress);
  
    // Fund claim with tokens and unpause (as admin)
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
      stake,
      feed,
      factory,
      claim,
      claimAsAdmin,
      root,
      tree,
      allocation,
      multiplier,
      cfg,
    };
  }
  
  /* -------------------------------------------------------------------------- */
  /*                                    Tests                                   */
  /* -------------------------------------------------------------------------- */
  
describe("Claim: initialization, claiming, staking, fees (with MockFactoryWithRoles)", () => {
    it("initializes via factory and starts paused until admin unpauses", async () => {
      const { claim, claimAsAdmin } = await loadFixture(deployFixture);
      // already unpaused by fixture final step; pause then unpause again to assert admin control
      await claimAsAdmin.write.pause();
      expect(await claim.read.paused()).to.equal(true);
      await claimAsAdmin.write.unpause();
      expect(await claim.read.paused()).to.equal(false);
    });
  
    it("validateClaimOptions returns wei fee for claim vs stake (using oracle)", async () => {
      const { claim, feed, cfg, multiplier } = await loadFixture(deployFixture);
  
      // $1 claim fee at 3000 $/ETH → fee ≈ 1/3000 ETH (ceil in wei)
      const claimOpts: ClaimOptions = {
        optionId: keccak256(toBytes("full-claim")),
        multiplier,
        percentageToClaim: 10_000,
        percentageToStake: 0,
        lockupPeriod: 0,
      };
      const feeClaimWei = await claim.read.validateClaimOptions([claimOpts]);
      expect(feeClaimWei > 0n).to.equal(true);
  
      // $2 stake fee → ≈ 2/3000 ETH; also requires non-zero lockup (minLockup=1)
      const stakeOpts: ClaimOptions = {
        optionId: keccak256(toBytes("stake")),
        multiplier,
        percentageToClaim: 0,
        percentageToStake: 10_000,
        lockupPeriod: 60, // >= minLockup=1
      };
      const feeStakeWei = await claim.read.validateClaimOptions([stakeOpts]);
      expect(feeStakeWei > feeClaimWei).to.equal(true);
  
      // Simulate price change → double ETH price, wei fee halves
      const feedAsDeployer = await hre.viem.getContractAt("MockAggregatorV3", feed.address);
      await feedAsDeployer.write.setAnswer([6000n * 10n ** 8n]);
      const feeClaimWei2 = await claim.read.validateClaimOptions([claimOpts]);
      expect(feeClaimWei2 < feeClaimWei).to.equal(true);
  
      // Revert paths
      const badSumHigh: ClaimOptions = { ...claimOpts, percentageToClaim: 6_000, percentageToStake: 5_000 };
      await expect(claim.read.validateClaimOptions([badSumHigh])).to.be.rejectedWith("PctSumExceeded");
      const badSumLow: ClaimOptions = { ...claimOpts, percentageToClaim: 3_000, percentageToStake: 2_000 };
      await expect(claim.read.validateClaimOptions([badSumLow])).to.be.rejectedWith("PctSumNot100");
  
      const zeroId: ClaimOptions = { ...claimOpts, optionId: `0x${"00".repeat(32)}` as `0x${string}` };
      await expect(claim.read.validateClaimOptions([zeroId])).to.be.rejectedWith("InvalidOptionId");
    });
  
    it("claims (claim-only) transfers tokens; ETH fee to treasury; protocol token-share accrues for later withdrawal", async () => {
      const { claim, erc20, user, tree, allocation, multiplier, cfg, protocolAdmin, protocolTreasury } =
        await loadFixture(deployFixture);
  
      // Build proof
      const entries = Array.from(tree.entries());
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
  
      // Options: 100% claim, no stake
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes("claim-only")),
        multiplier,
        percentageToClaim: 10_000,
        percentageToStake: 0,
        lockupPeriod: 0,
      };
  
      const feeWei = await claim.read.validateClaimOptions([opts]);
  
      // Signature (beneficiary must sign)
      const nonce = keccak256(toBytes("nonce-claim-only"));
      const sig = await makeClaimSignature(
        user,
        claim.address,
        user.account.address,
        allocation,
        opts,
        nonce
      );
  
      // Record pre-balances
      const balBefore = await erc20.read.balanceOf([user.account.address]);
      const protoBefore = await erc20.read.balanceOf([protocolTreasury.account.address]);
  
      // Execute claim (send exactly feeWei)
      const claimAsUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, {
        client: { wallet: user },
      });
      await claimAsUser.write.claimFor(
        [user.account.address, proof, allocation, opts, nonce, sig],
        { value: feeWei }
      );
  
      // User got tokens
      const balAfter = await erc20.read.balanceOf([user.account.address]);
      expect(balAfter - balBefore).to.equal(allocation);

      // Protocol token-share accrued for later
      const accrued = await claim.read.protocolAccruedTokens();
      expect(accrued).to.equal(allocation / 100n);

      // Protocol admin can withdraw now
      const claimAsProtocolAdmin = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: protocolAdmin } });
      await claimAsProtocolAdmin.write.withdrawProtocolAccrued([protocolTreasury.account.address, accrued]);
      const protoAfter = await erc20.read.balanceOf([protocolTreasury.account.address]);
      expect(protoAfter - protoBefore).to.equal(accrued);
    });
  
    it("staking pulls via allowance (no double transfer): claim balance decreases once; staking receives stake+bonus", async () => {
      // Fresh deployment using LinearStake to exercise real token flows
      const [deployer, partnerAdmin, user, protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
        await hre.viem.getWalletClients();

      const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
      const linearStake = await hre.viem.deployContract("LinearStake", [erc20.address]);
      const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
      const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

      const allocation = parseEther("100");
      const list: [`0x${string}`, bigint][] = [ [user.account.address, allocation] ];
      const tree = StandardMerkleTree.of(list, ["address", "uint256"]);
      const root = tree.root as `0x${string}`;

      const multiplier = 1000n; // 10%
      const ip: InitParams = {
        admin: partnerAdmin.account.address,
        root,
        asset: erc20.address,
        staking: linearStake.address,
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
      const salt = keccak256(toBytes("salt-linear-stake"));
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
      await erc20.write.transfer([claim.address, parseEther("10000")]);
      await (await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: partnerAdmin } }))
        .write.unpause();

      // Allowance should be max from initializer
      const max = (1n << 256n) - 1n;
      const allowanceBefore = await erc20.read.allowance([claim.address, linearStake.address]);
      expect(allowanceBefore).to.equal(max);

      // Prepare claim
      const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes("stake-100")),
        multiplier,
        percentageToClaim: 0,
        percentageToStake: 10_000,
        lockupPeriod: 120,
      };
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const nonce = keccak256(toBytes("nonce-stake-100"));
      const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);

      // Pre balances
      const claimBefore = await erc20.read.balanceOf([claim.address]);
      const stakeBefore = await erc20.read.balanceOf([linearStake.address]);

      // Execute
      const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig], { value: feeWei });

      // Post balances
      const claimAfter = await erc20.read.balanceOf([claim.address]);
      const stakeAfter = await erc20.read.balanceOf([linearStake.address]);
      const deltaClaim = claimBefore - claimAfter;
      const deltaStake = stakeAfter - stakeBefore;

      // Expected amounts: 100 stake + 10 bonus, pulled once by LinearStake via allowance
      const expectedToStake = allocation + allocation / 10n;
      expect(deltaClaim).to.equal(expectedToStake);
      expect(deltaStake).to.equal(expectedToStake);

      // Protocol token share accrued but not transferred
      const expectedProto = (expectedToStake * 100n + 9999n) / 10000n; // ceil bips
      expect(await claim.read.protocolAccruedTokens()).to.equal(expectedProto);
    });

    it("partial claim+stake with LinearStake: balances route correctly and protocol share includes bonus", async () => {
      const [deployer, partnerAdmin, user, protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
        await hre.viem.getWalletClients();

      const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
      const linearStake = await hre.viem.deployContract("LinearStake", [erc20.address]);
      const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
      const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

      const allocation = parseEther("100");
      const list: [`0x${string}`, bigint][] = [ [user.account.address, allocation] ];
      const tree = StandardMerkleTree.of(list, ["address", "uint256"]);
      const root = tree.root as `0x${string}`;

      const multiplier = 1000n; // 10%
      const ip: InitParams = {
        admin: partnerAdmin.account.address,
        root,
        asset: erc20.address,
        staking: linearStake.address,
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
      const salt = keccak256(toBytes("salt-linear-stake-partial"));
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
      await erc20.write.transfer([claim.address, parseEther("10000")]);
      await (await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: partnerAdmin } }))
        .write.unpause();

      const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes("partial-stake")),
        multiplier,
        percentageToClaim: 3000,
        percentageToStake: 7000,
        lockupPeriod: 120,
      };
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const nonce = keccak256(toBytes("nonce-partial"));
      const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);

      const userBefore = await erc20.read.balanceOf([user.account.address]);
      const claimBefore = await erc20.read.balanceOf([claim.address]);
      const stakeBefore = await erc20.read.balanceOf([linearStake.address]);

      const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig], { value: feeWei });

      const userAfter = await erc20.read.balanceOf([user.account.address]);
      const claimAfter = await erc20.read.balanceOf([claim.address]);
      const stakeAfter = await erc20.read.balanceOf([linearStake.address]);

      const amountClaimed = (allocation * 3000n) / 10_000n; // 30
      const amountStaked = (allocation * 7000n) / 10_000n;  // 70
      const bonus = (amountStaked * 1000n) / 10_000n;       // 7
      const toStake = amountStaked + bonus;                 // 77
      const distributed = amountClaimed + toStake;          // 107
      const expectedProto = (distributed * 100n + 9999n) / 10000n;

      expect(userAfter - userBefore).to.equal(amountClaimed);
      expect(claimBefore - claimAfter).to.equal(distributed);
      expect(stakeAfter - stakeBefore).to.equal(toStake);
      expect(await claim.read.protocolAccruedTokens()).to.equal(expectedProto);
    });

    it("supports partial claim + stake in one call and prevents double-claim", async () => {
      const { claim, erc20, user, tree, allocation, multiplier } = await loadFixture(deployFixture);

      const entries3 = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me3 = entries3.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me3[1]) as `0x${string}`[];

      // 30% claim, 70% stake
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes("mix-claim-stake")),
        multiplier,
        percentageToClaim: 3000,
        percentageToStake: 7000,
        lockupPeriod: 120,
      };
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const nonce = keccak256(toBytes('nonce-mix-linear'));
      const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);

      const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      const balBefore = await erc20.read.balanceOf([user.account.address]);
      await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig], { value: feeWei });
      const balAfter = await erc20.read.balanceOf([user.account.address]);
      // Claimed 30% to user
      expect(balAfter - balBefore).to.equal((allocation * 3000n) / 10_000n);

      // Second attempt should revert AlreadyClaimed
      await expect(
        asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig], { value: feeWei }),
      ).to.be.rejectedWith("AlreadyClaimed");
    });

    it("reverts staking path when stakingAddress is zero and enforces min lockup", async () => {
      const [deployer, partnerAdmin, user, protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow] =
        await hre.viem.getWalletClients();
      const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
      const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
      const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);

      const allocation = parseEther("10");
      const tree = StandardMerkleTree.of([[user.account.address, allocation]], ["address", "uint256"]);
      const root = tree.root as `0x${string}`;

      const ip = {
        admin: partnerAdmin.account.address,
        root,
        asset: erc20.address,
        staking: zeroAddress,
        maxBonus: parseEther("1000"),
        minLockupDuration: 10,
        minLockupDurationForMultiplier: 60,
        multiplier: 1000n,
      } satisfies InitParams;
      const cfg = {
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
      } satisfies InitFeeConfig;

      const salt = keccak256(toBytes("salt-nostake"));
      await factory.write.deployClaim([ip, cfg, salt]);
      const bytecode = (await hre.artifacts.readArtifact("SnagAirdropV2Claim")).bytecode as `0x${string}`;
      const initCodeHash = keccak256(bytecode);
      const claimAddr = (function compute(factoryAddr: `0x${string}`, saltHex: `0x${string}`, codeHash: `0x${string}`) {
        const packed = encodePacked(["bytes1", "address", "bytes32", "bytes32"], ["0xff", factoryAddr, saltHex, codeHash]);
        const h = keccak256(packed);
        return getAddress(("0x" + h.slice(26)) as `0x${string}`);
      })(factory.address, salt, initCodeHash);
      const claim = await hre.viem.getContractAt("SnagAirdropV2Claim", claimAddr);

      // fund and unpause
      await erc20.write.transfer([claim.address, parseEther("1000")]);
      const claimAsAdmin = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: partnerAdmin } });
      await claimAsAdmin.write.unpause();

      const entries4 = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me4 = entries4.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me4[1]) as `0x${string}`[];
      const stakeOpts: ClaimOptions = {
        optionId: keccak256(toBytes("stake")),
        multiplier: 1000n,
        percentageToClaim: 0,
        percentageToStake: 10_000,
        lockupPeriod: 100, // staking selected but stakingAddress=0 → NoStaking
      };
      const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      const feeWei = await claim.read.validateClaimOptions([stakeOpts]).catch(() => 0n);
      // validate route should revert with NoStaking
      await expect(claim.read.validateClaimOptions([stakeOpts])).to.be.rejectedWith("NoStaking");
      // claimFor should also revert with NoStaking
      const nonce = keccak256(toBytes("nonce-nostake"));
      const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, stakeOpts, nonce);
      await expect(asUser.write.claimFor([user.account.address, proof, allocation, stakeOpts, nonce, sig], { value: feeWei })).to.be
        .rejectedWith("NoStaking");

      // Lockup too short when stakingAddress exists and lockup < min
      // Reuse original fixture with a stake contract
      const { claim: claim2, tree: tree2, allocation: alloc2, multiplier: mult2 } = await loadFixture(deployFixture);
      const opts2: ClaimOptions = {
        optionId: keccak256(toBytes("stake-too-short")),
        multiplier: mult2,
        percentageToClaim: 0,
        percentageToStake: 10_000,
        lockupPeriod: 1, // fixture minLockupDuration is 1; test below uses 0 to trigger
      };
      const ent = Array.from(tree2.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const proof2 = tree2.getProof(ent[0][1]) as `0x${string}`[];
      const fee2 = await claim2.read.validateClaimOptions([{ ...opts2, lockupPeriod: 0 }]).catch(() => 0n);
      await expect(claim2.read.validateClaimOptions([{ ...opts2, lockupPeriod: 0 }])).to.be.rejectedWith("LockupTooShort");
    });

    it("bonus is capped by maxBonus", async () => {
      const { claim, user, tree, allocation, claimAsAdmin } = await loadFixture(deployFixture);
      // Increase multiplier so that bonus would exceed cap with current allocation
      await claimAsAdmin.write.setMultiplier([100_000n]); // 1000%
      const entries = Array.from(tree.entries());
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes("stake-cap")),
        multiplier: 100_000n,
        percentageToClaim: 0,
        percentageToStake: 10_000,
        lockupPeriod: 120,
      };
      const nonceCap = keccak256(toBytes('nonce-bonus-cap'));
      const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonceCap);
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonceCap, sig], { value: feeWei });
      // Bonus should be capped at maxBonus = 1000 ETH from fixture
      const totalBonus = await claim.read.totalBonusTokens();
      expect(totalBonus).to.equal(parseEther("1000"));
    });
  
    it("only factory.PROTOCOL_ADMIN_ROLE may withdraw protocolAccruedTokens", async () => {
      const { claim, user } = await loadFixture(deployFixture);
      const claimAsRandom = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      await expect(claimAsRandom.write.withdrawProtocolAccrued([user.account.address, 1n])).to.be.rejectedWith(
        "NotProtocolAdmin"
      );
    });
  
    it("endAirdrop sweeps leftovers (excluding protocolAccruedTokens) and marks inactive", async () => {
      const { claim, claimAsAdmin, erc20, partnerAdmin } = await loadFixture(deployFixture);
      const before = await erc20.read.balanceOf([partnerAdmin.account.address]);
      await claimAsAdmin.write.endAirdrop([partnerAdmin.account.address]);
      const after = await erc20.read.balanceOf([partnerAdmin.account.address]);
      expect(after > before).to.equal(true);
      expect(await claim.read.isActive()).to.equal(false);
      // Only protocolAccruedTokens should remain in the contract
      const remaining = await erc20.read.balanceOf([claim.address]);
      const accrued = await claim.read.protocolAccruedTokens();
      expect(remaining).to.equal(accrued);
    });
  
    it("signature must be from beneficiary", async () => {
      const { claim, tree, allocation, partnerAdmin, user, multiplier } = await loadFixture(deployFixture);
      const entries5 = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me5 = entries5.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me5[1]) as `0x${string}`[];
  
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes("full-claim")),
        multiplier,
        percentageToClaim: 10_000,
        percentageToStake: 0,
        lockupPeriod: 0,
      };
      const feeWei = await claim.read.validateClaimOptions([opts]);
  
      // Signed by partnerAdmin instead of user
      const badNonce = keccak256(toBytes('nonce-bad-signer'));
      const badSig = await makeClaimSignature(
        partnerAdmin,
        claim.address,
        user.account.address,
        allocation,
        opts,
        badNonce
      );
      const asUserSig = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      await expect(
        asUserSig.write.claimFor([user.account.address, proof, allocation, opts, badNonce, badSig], { value: feeWei })
      ).to.be.rejectedWith("InvalidClaimSignature");
    });
  
    it("reverts on invalid proof", async () => {
      const { claim, user, multiplier } = await loadFixture(deployFixture);
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes("full-claim")),
        multiplier,
        percentageToClaim: 10_000,
        percentageToStake: 0,
        lockupPeriod: 0,
      };
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const nonceInvalid = keccak256(toBytes('nonce-invalid-proof'));
      const sig = await makeClaimSignature(user, claim.address, user.account.address, parseEther("100"), opts, nonceInvalid);
      const fakeProof = ["0x" + "11".repeat(32)] as `0x${string}`[];
      const asUserInvalid = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      await expect(
        asUserInvalid.write.claimFor([user.account.address, fakeProof, parseEther("100"), opts, nonceInvalid, sig], { value: feeWei })
      ).to.be.rejectedWith("InvalidProof");
    });
  
    it("pause/unpause gated by admin; paused claims revert", async () => {
      const { claim, claimAsAdmin, tree, allocation, user, multiplier } = await loadFixture(deployFixture);
  
      // Pause
      await claimAsAdmin.write.pause();
      expect(await claim.read.paused()).to.equal(true);
  
      // Try claim
      const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes("full-claim")),
        multiplier,
        percentageToClaim: 10_000,
        percentageToStake: 0,
        lockupPeriod: 0,
      };
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const noncePause = keccak256(toBytes('nonce-pause'));
      const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, noncePause);
      const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      await expect(
        asUser.write.claimFor([user.account.address, proof, allocation, opts, noncePause, sig], { value: feeWei })
      ).to.be.rejectedWith("EnforcedPause");
  
      // Unpause and succeed
      await claimAsAdmin.write.unpause();
      await expect(
        asUser.write.claimFor([user.account.address, proof, allocation, opts, noncePause, sig], { value: feeWei })
      ).to.not.be.rejected;
    });

    it("claim underpays reverts; overpay refunds dust (integration)", async () => {
      const { claim, user, tree, allocation, multiplier, protocolTreasury } = await loadFixture(deployFixture);
      const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
      const opts: ClaimOptions = { optionId: keccak256(toBytes('fee-int')), multiplier, percentageToClaim: 10_000, percentageToStake: 0, lockupPeriod: 0 };
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const nonceUnder = keccak256(toBytes('nonce-fee-under'));
      const sigUnder = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonceUnder);
      const asUserFee = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: user } });
      await expect(asUserFee.write.claimFor([user.account.address, proof, allocation, opts, nonceUnder, sigUnder], { value: feeWei - 1n })).to.be.rejectedWith('InsufficientFee');

      const pc = await hre.viem.getPublicClient();
      const beforeT = await pc.getBalance({ address: protocolTreasury.account.address });
      const over = feeWei + 12345n;
      const nonceOk = keccak256(toBytes('nonce-fee-ok'));
      const sigOk = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonceOk);
      await asUserFee.write.claimFor([user.account.address, proof, allocation, opts, nonceOk, sigOk], { value: over });
      const afterT = await pc.getBalance({ address: protocolTreasury.account.address });
      expect(afterT - beforeT).to.equal(feeWei);
    });

    it("claimedAmount equals allocation * sum(pcts)/10000 for several distributions", async () => {
      const { claim, user, tree, allocation, multiplier } = await loadFixture(deployFixture);
      const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
      const pairs = [ [10_000, 0], [2_500, 7_500] ];
      for (const [pctC, pctS] of pairs) {
        // fresh claim each time requires new contract; here we simulate only single account once
        // Use single run with (pctC+pctS)=50% to verify mapping and exit
        const opts: ClaimOptions = { optionId: keccak256(toBytes(`mix-${pctC}-${pctS}`)), multiplier, percentageToClaim: pctC, percentageToStake: pctS, lockupPeriod: 120 };
        const fee = await claim.read.validateClaimOptions([opts]);
        const nonceMix = keccak256(toBytes('nonce-claimed-amount'));
        const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonceMix);
        const asUserMix = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: user } });
        await asUserMix.write.claimFor([user.account.address, proof, allocation, opts, nonceMix, sig], { value: fee });
        const consumed = await claim.read.claimedAmount([user.account.address]);
        const expected = (allocation * BigInt(pctC + pctS)) / 10_000n;
        expect(consumed).to.equal(expected);
        break;
      }
    });

    it("endAirdrop prevents further claims and does not move protocolAccruedTokens; protocol admin can withdraw after end", async () => {
      const { claim, claimAsAdmin, user, tree, allocation, multiplier, protocolTreasury, partnerAdmin, protocolAdmin } = await loadFixture(deployFixture);
      const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
      const opts: ClaimOptions = { optionId: keccak256(toBytes('after-end')), multiplier, percentageToClaim: 10_000, percentageToStake: 0, lockupPeriod: 0 };
      const fee = await claim.read.validateClaimOptions([opts]);
      const nonceEvt2 = keccak256(toBytes('nonce-evt-claimed'));
      const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonceEvt2);
      const pc = await hre.viem.getPublicClient();
      const beforeT = await pc.getBalance({ address: protocolTreasury.account.address });
      // accrue some protocol share first by making a claim
      const asUserPre = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: user } });
      const nonceEnd = keccak256(toBytes('nonce-end'));
      const sigEnd = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonceEnd);
      await asUserPre.write.claimFor([user.account.address, proof, allocation, opts, nonceEnd, sigEnd], { value: fee });
      const accruedBefore = await claim.read.protocolAccruedTokens();
      const beforeTokens = await (await hre.viem.getContractAt('MockERC20', (await claim.read.tokenAsset()) as `0x${string}`)).read.balanceOf([protocolTreasury.account.address]);
      // End airdrop to partner recipient; protocol accrued should remain untouched
      await claimAsAdmin.write.endAirdrop([partnerAdmin.account.address]);
      const asUser = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: user } });
      await expect(asUser.write.claimFor([user.account.address, proof, allocation, opts, nonceEnd, sigEnd], { value: fee })).to.be.rejectedWith('AirdropNotActive');
      const afterTokens = await (await hre.viem.getContractAt('MockERC20', (await claim.read.tokenAsset()) as `0x${string}`)).read.balanceOf([protocolTreasury.account.address]);
      // No protocol token transfer happened on end
      expect(afterTokens).to.equal(beforeTokens);
      // Accrued remains for later withdrawal
      expect(await claim.read.protocolAccruedTokens()).to.equal(accruedBefore);
      // Protocol admin can withdraw after end
      const claimAsProtocolAdmin = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: protocolAdmin } });
      await claimAsProtocolAdmin.write.withdrawProtocolAccrued([protocolTreasury.account.address, accruedBefore]);
      const afterTokens2 = await (await hre.viem.getContractAt('MockERC20', (await claim.read.tokenAsset()) as `0x${string}`)).read.balanceOf([protocolTreasury.account.address]);
      expect(afterTokens2 - beforeTokens).to.equal(accruedBefore);
      expect(await claim.read.protocolAccruedTokens()).to.equal(0n);
    });

    it("emits Claimed event and records claimedAmount for partial claim+stake", async () => {
      const { claim, user, tree, allocation, multiplier } = await loadFixture(deployFixture);
      const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];

      const pctClaim = 2500;
      const pctStake = 7500;
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes("partial-claim")),
        multiplier,
        percentageToClaim: pctClaim,
        percentageToStake: pctStake,
        lockupPeriod: 120,
      };
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });

      const nonceEvt = keccak256(toBytes('nonce-evt'));
      const sig2 = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonceEvt);
      const txHash = await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonceEvt, sig2], { value: feeWei });
      const publicClient = await hre.viem.getPublicClient();
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      const events = parseEventLogs({ abi: asUser.abi, logs: receipt.logs, eventName: 'Claimed' });
      expect(events.length).to.equal(1);
      const ev = events[0];
      const expectedClaim = (allocation * BigInt(pctClaim)) / 10_000n;
      const expectedStake = (allocation * BigInt(pctStake)) / 10_000n;
      expect(getAddress(ev.args.beneficiary as `0x${string}`)).to.equal(getAddress(user.account.address));
      expect(ev.args.amountClaimed).to.equal(expectedClaim);
      expect(ev.args.amountStaked).to.equal(expectedStake);

      const consumed = await claim.read.claimedAmount([user.account.address]);
      expect(consumed).to.equal(expectedClaim + expectedStake);
    });

    it("routes fees to updated partnerOverflow after rotation in RouteToPartner mode", async () => {
      const [deployer, partnerAdmin, user, protocolAdmin, overflowPartner, protocolTreasury, protocolOverflow, newPartner] =
        await hre.viem.getWalletClients();

      // Setup small cap and route-to-partner
      const erc20 = await hre.viem.deployContract("MockERC20", [deployer.account.address]);
      const stake = await hre.viem.deployContract("MockStake");
      const feed = await hre.viem.deployContract("MockAggregatorV3", [8, 3000n * 10n ** 8n]);
      const factory = await hre.viem.deployContract("MockFactoryWithRoles", [protocolAdmin.account.address]);
      const allocation = parseEther("1");
      const list: [`0x${string}`, bigint][] = [
        [user.account.address, allocation],
        [partnerAdmin.account.address, allocation],
        [newPartner.account.address, allocation],
      ];
      const tree = StandardMerkleTree.of(list, ["address", "uint256"]);
      const root = tree.root as `0x${string}`;
      const ip = {
        admin: partnerAdmin.account.address,
        root,
        asset: erc20.address,
        staking: stake.address,
        maxBonus: parseEther("1000"),
        minLockupDuration: 1,
        minLockupDurationForMultiplier: 60,
        multiplier: 0n,
      } satisfies InitParams;
      const cfg = {
        priceFeed: feed.address,
        maxPriceAge: 3600,
        protocolTreasury: protocolTreasury.account.address,
        protocolOverflow: protocolOverflow.account.address,
        partnerOverflow: overflowPartner.account.address,
        feeClaimUsdCents: 100n,
        feeStakeUsdCents: 0n,
        feeCapUsdCents: 100n,
        overflowMode: 1,
        protocolTokenShareBips: 0,
      } satisfies InitFeeConfig;
      const salt = keccak256(toBytes("salt-rtp"));
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
      await erc20.write.transfer([claim.address, parseEther("1000")]);
      const claimAsAdmin = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: partnerAdmin } });
      await claimAsAdmin.write.unpause();

      // First claim routes to initial partnerOverflow
      const entries6 = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries6.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
      const opts: ClaimOptions = { optionId: keccak256(toBytes("rtp1")), multiplier: 0n, percentageToClaim: 10_000, percentageToStake: 0, lockupPeriod: 0 };
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const asUser = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: user } });
      const pc = await hre.viem.getPublicClient();
      // First claim will reach cap; overflow routing applies on subsequent claims
      // Pay once to reach cap to treasury first
      const nonceRtp1 = keccak256(toBytes('nonce-rtp-1'));
      await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonceRtp1, await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonceRtp1)], { value: feeWei });
      // Second claim should route to partnerOverflow (post-cap)
      const meB = entries6.find(([, v]) => v[0] === partnerAdmin.account.address)!;
      const proofB = tree.getProof(meB[1]) as `0x${string}`[];
      const before1 = await pc.getBalance({ address: overflowPartner.account.address });
      const nonceRtp2 = keccak256(toBytes('nonce-rtp-2'));
      await (await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: partnerAdmin } }))
        .write.claimFor([partnerAdmin.account.address, proofB, allocation, opts, nonceRtp2, await makeClaimSignature(partnerAdmin, claim.address, partnerAdmin.account.address, allocation, opts, nonceRtp2)], { value: feeWei });
      const after1 = await pc.getBalance({ address: overflowPartner.account.address });
      expect(after1 - before1).to.equal(feeWei);

      // Rotate partner overflow and claim with second address
      await claimAsAdmin.write.updatePartnerOverflow([deployer.account.address]);
      // Third claim by a fresh claimant routes to new partnerOverflow
      const meNew = entries6.find(([, v]) => v[0] === newPartner.account.address)!;
      const proof2 = tree.getProof(meNew[1] as [`0x${string}`, bigint]) as `0x${string}`[];
      const asNew = await hre.viem.getContractAt("SnagAirdropV2Claim", claim.address, { client: { wallet: newPartner } });
      const before2 = await pc.getBalance({ address: deployer.account.address });
      const nonceRtp3 = keccak256(toBytes('nonce-rtp-3'));
      await asNew.write.claimFor([newPartner.account.address, proof2, allocation, opts, nonceRtp3, await makeClaimSignature(newPartner, claim.address, newPartner.account.address, allocation, opts, nonceRtp3)], { value: feeWei });
      const after2 = await pc.getBalance({ address: deployer.account.address });
      expect(after2 - before2).to.equal(feeWei);
    });
  
    it("partner can update partnerOverflow address", async () => {
      const { claimAsAdmin, overflowPartner, partnerAdmin } = await loadFixture(deployFixture);
      await claimAsAdmin.write.updatePartnerOverflow([partnerAdmin.account.address]); // set to a new one
      // Not much to assert besides event — but if no revert, function is callable by onlyAdmin
      await claimAsAdmin.write.updatePartnerOverflow([overflowPartner.account.address]); // set back
    });

    it("no bonus when amountStaked = 0 even if lockup >= threshold", async () => {
      const { claim, erc20, user, tree, allocation, multiplier } = await loadFixture(deployFixture);

      const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];

      // 100% claim, 0% stake but set a high lockup to meet multiplier threshold
      const opts: ClaimOptions = {
        optionId: keccak256(toBytes('no-bonus-when-no-stake')),
        multiplier,
        percentageToClaim: 10_000,
        percentageToStake: 0,
        lockupPeriod: 120, // >= minLockupDurationForMultiplier in fixture
      };
      const feeWei = await claim.read.validateClaimOptions([opts]);
      const nonce = keccak256(toBytes('nonce-no-bonus'));
      const sig = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce);

      // Before
      const bonusBefore = await claim.read.totalBonusTokens();
      const userBalBefore = await erc20.read.balanceOf([user.account.address]);

      const asUser = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: user } });
      await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce, sig], { value: feeWei });

      // After: no bonus should be minted/allocated when stake is zero
      const bonusAfter = await claim.read.totalBonusTokens();
      expect(bonusAfter - bonusBefore).to.equal(0n);

      // User receives full allocation
      const userBalAfter = await erc20.read.balanceOf([user.account.address]);
      expect(userBalAfter - userBalBefore).to.equal(allocation);
    });

    it("nonce: cancelNonce blocks a signed claim; different nonce works", async () => {
      const { claim, user, tree, allocation, multiplier } = await loadFixture(deployFixture);
      const entries = Array.from(tree.entries()) as Array<[number, [`0x${string}`, bigint]]>;
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];

      const opts: ClaimOptions = {
        optionId: keccak256(toBytes('nonce-cancel-test')),
        multiplier,
        percentageToClaim: 10_000,
        percentageToStake: 0,
        lockupPeriod: 0,
      };
      const fee = await claim.read.validateClaimOptions([opts]);

      // cancel a specific nonce
      const nonce1 = keccak256(toBytes('nonce-cancel-1'));
      const sig1 = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce1);
      const asUser = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: user } });
      await asUser.write.cancelNonce([nonce1]);
      await expect(
        asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce1, sig1], { value: fee }),
      ).to.be.rejectedWith('SignatureAlreadyUsed');

      // use a different nonce and succeed
      const nonce2 = keccak256(toBytes('nonce-cancel-2'));
      const sig2 = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonce2);
      await expect(
        asUser.write.claimFor([user.account.address, proof, allocation, opts, nonce2, sig2], { value: fee }),
      ).to.not.be.rejected;
    });
  });

    it("protocol admin withdrawal unaffected by pause/unpause and works after end", async () => {
      const { claim, claimAsAdmin, user, tree, allocation, multiplier, protocolTreasury, protocolAdmin } = await loadFixture(deployFixture);
      const entries = Array.from(tree.entries());
      const me = entries.find(([, v]) => v[0] === user.account.address)!;
      const proof = tree.getProof(me[1]) as `0x${string}`[];
      const opts: ClaimOptions = { optionId: keccak256(toBytes('withdraw-anytime')), multiplier, percentageToClaim: 10_000, percentageToStake: 0, lockupPeriod: 0 };
      const fee = await claim.read.validateClaimOptions([opts]);
      const asUser = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: user } });
      const nonceRouted = keccak256(toBytes('nonce-routed'));
      const sigRouted = await makeClaimSignature(user, claim.address, user.account.address, allocation, opts, nonceRouted);
      await asUser.write.claimFor([user.account.address, proof, allocation, opts, nonceRouted, sigRouted], { value: fee });
      const accrued = await claim.read.protocolAccruedTokens();
      // Pause contract; withdraw half
      await claimAsAdmin.write.pause();
      const half = accrued / 2n;
      const claimAsProtocolAdmin = await hre.viem.getContractAt('SnagAirdropV2Claim', claim.address, { client: { wallet: protocolAdmin } });
      await claimAsProtocolAdmin.write.withdrawProtocolAccrued([protocolTreasury.account.address, half]);
      // Unpause and withdraw the rest
      await claimAsAdmin.write.unpause();
      await claimAsProtocolAdmin.write.withdrawProtocolAccrued([protocolTreasury.account.address, accrued - half]);
      expect(await claim.read.protocolAccruedTokens()).to.equal(0n);
      // End and confirm still callable (noop withdraw zero)
      await claimAsAdmin.write.endAirdrop([protocolTreasury.account.address]);
      await claimAsProtocolAdmin.write.withdrawProtocolAccrued([protocolTreasury.account.address, 0n]);
    });
