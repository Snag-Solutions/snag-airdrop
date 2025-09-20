# Snag Airdrop V2 – Contracts

This package contains the on‑chain core for Snag’s airdrop protocol: a signed factory that deploys claim contracts, and claim contracts that support claim‑only or claim‑and‑stake flows with flexible fee models.

- Contracts
  - Factory: `contracts/Factory.sol`
  - Claim: `contracts/Claim.sol`
  - Fee module (internal): `contracts/modules/SnagFeeModule.sol`
  - Interfaces: `contracts/interfaces/`
  - Tests: `test/`

See `contracts/interfaces/ISnagAirdropV2Claim.sol` and `contracts/interfaces/ISnagAirdropV2Factory.sol` for rich, function‑level documentation (NatSpec), and `test/` for executable examples.

## Deploying a Claim Contract

Deployments happen via the signed‑only factory. A protocol signer authorizes the full payload (airdrop params + fee config + one‑time deployment fee) with EIP‑712. The deployer submits the transaction and pays any one‑time deployment fee in native currency.

- Roles
  - Protocol Admin (factory): manages protocol signers and can withdraw protocol token share from claims.
  - Protocol Signer (factory): authorizes create payloads off‑chain (EIP‑712).
  - Partner Admin (claim): controls pause/unpause, bonus multiplier, partner overflow address, and can end the airdrop.

- Deployment Options (CreateParams)
  - `salt`: CREATE2 salt (scoped to deployer address).
  - `admin`: partner admin for the claim.
  - `root`: Merkle root for allocations.
  - `token`: ERC‑20 token to distribute.
  - `staking`: optional staking contract (must support `IBaseStake`).
  - `maxBonus`: max bonus tokens per claim (absolute cap).
  - `minLockup`: min lockup required to allow staking.
  - `minLockupForMultiplier`: lockup required to receive bonus multiplier.
  - `multiplier`: bonus multiplier (bips, 10_000 = 100%).

- Fee Config (ProtocolFeeConfig)
  - `feeClaimUsdCents`, `feeStakeUsdCents`: flat USD‑pegged fees (paid in native) for claim‑only vs claim+stake.
  - `feeCapUsdCents`: global USD cap; once reached, overflow routing applies (see below).
  - `priceFeed`, `maxPriceAge`: Chainlink aggregator and freshness window.
  - `protocolTreasury`: pre‑cap receiver for USD‑pegged fees (and protocol token share on end/withdraw).
  - `protocolOverflow`, `partnerOverflow`: post‑cap receivers depending on overflow mode; partner may rotate `partnerOverflow` via the claim.
  - `overflowMode`: one of Cancel / RouteToPartner / RouteToProtocol.
  - `protocolTokenShareBips`: percentage of distributed tokens routed to protocol (does not reduce user amounts).

### How Fees Work

Snag provides multiple flexible ways to structure protocol fees. These fees are always agreed in advance, locked in on‑chain at deployment, and never change. Partners can choose one, many, or none of these options.

1) Per‑user claim/stake fee (USD‑pegged, paid in native)
   - For each user action, the claim charges a flat fee in native currency pegged to USD. The fee can differ for “claim only” vs “claim + stake”.
   - A global cap (e.g., $20,000) limits total USD collected. After the cap, overflow routing applies per `overflowMode`:
     - Cancel: disable fee for new users.
     - RouteToProtocol: fees continue but to a protocol overflow address.
     - RouteToPartner: fees continue but to a partner‑designated overflow address (rotatable by partner admin).

2) Token percentage fee
   - A small percentage (e.g., 1%) of each user’s distribution is set aside for protocol. The base includes claimed tokens, staked tokens, and any bonus tokens. This does not reduce user amounts.
   - Tokens accrue in the claim contract. The protocol admin can withdraw at any time. Ending the airdrop does not move the accrued amount; it remains withdrawable by the protocol admin.

3) One‑time deployment fee (USD‑pegged, paid in native)
   - Optional up‑front fee when creating a claim contract. Collected by the factory and sent to `protocolTreasury`.

Mix‑and‑match: These models are modular. Partners can choose no fees, only deployment fees, only per‑claim USD fees, only token share, or any combination.

## Claiming: Options and Behavior

Users submit an EIP‑712 signed `ClaimOptions` along with a Merkle proof and allocation:

- ClaimOptions
  - `optionId`: unique (non‑zero) option identifier; binds the signature.
  - `multiplier`: bonus multiplier (bips) expected by the signer; must match the on‑chain value at claim time (prevents signing against stale UI values).
  - `percentageToClaim`, `percentageToStake`: bips that sum to at most 10_000.
  - `lockupPeriod`: seconds; must satisfy `minLockupDuration` (for any stake) and `minLockupDurationForMultiplier` (for bonus eligibility).

- Effects
  - “Claim only”: tokens transfer directly to the user. USD‑pegged fee charged in native (if enabled). No bonus.
  - “Claim + stake”: tokens route to the staking contract. If `lockupPeriod ≥ minLockupDurationForMultiplier`, a bonus is added to the staked amount: `bonus = min(maxBonus, staked * multiplier / 10_000)`. The bonus applies only to the staked portion and is funded from the claim’s token balance.
  - Percentage token fee: protocol share = ceil((claimed + staked + bonus) * bips / 10,000). Accrues in the claim contract for protocol admin withdrawal; not moved automatically on airdrop end.
  - `claimedAmount[user]` stores the consumed amount = allocation * (percentageToClaim + percentageToStake) / 10,000.

- Pausing and End
  - Partner admin can pause/unpause claims.
  - Ending the airdrop sweeps only leftover user tokens to a partner recipient. It does not affect `protocolAccruedTokens`. Subsequent claims revert. Protocol admin withdrawals are unaffected by pause/unpause or end.

### Bonus Multiplier Details

- The active multiplier is stored on‑chain (bips). Partner admin may update it via `setMultiplier(newMultiplier)`; the value used for a claim must match the `multiplier` field signed in `ClaimOptions` (EIP‑712) or the claim reverts.
- Eligibility requires: `percentageToStake > 0` and `lockupPeriod ≥ minLockupDurationForMultiplier`.
- Computation: `bonus = min(maxBonus, stakedAmount * multiplier / 10_000)`. The bonus is added to the tokens sent to the staking contract. No bonus is applied in claim‑only flows.
- Protocol’s percentage token fee is computed on the sum `(amountClaimed + amountStaked + bonus)`.

## Developer Notes

- Interfaces contain rich NatSpec; contracts use `@inheritdoc`.
- For larger contract questions, see the generated docs in the `docs/` folder (kept in‑repo). GitHub will render these Markdown files directly.
- Tests demonstrate end‑to‑end deployment, fee collection (USD fee + percentage fee), overflow routing, staking + bonus, and end‑of‑airdrop behavior.
- SDK: this package includes `@snag/airdrop-sdk` for higher‑level integration helpers.
