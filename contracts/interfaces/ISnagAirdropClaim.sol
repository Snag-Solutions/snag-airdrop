// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import {ILinearStake} from "./ILinearStake.sol";

/// @notice Interface for the SnagAirdropClaim contract, including all errors.
interface ISnagAirdropClaim {
    /// @dev Mirrors the ClaimOptions struct in SnagAirdropClaim.
    struct ClaimOptions {
        bytes32 optionId;        // off-chain option identifier
        uint8  percentageToClaim; 
        uint8  percentageToStake; 
        uint32 lockupPeriod;     // in seconds
    }

    // ───────────── Errors ─────────────────────────────────────────

    /// @notice Thrown when contract balance is insufficient for a transfer.
    /// @param required  Amount that was required.
    /// @param available Amount actually available.
    error OutOfTokens(uint256 required, uint256 available);

    /// @notice Thrown when a function guarded by `onlyRouter` is called by a non-router.
    error OnlyRouter();

    /// @notice Thrown if the EIP-712 signature does not match the expected beneficiary.
    error InvalidSignature();

    /// @notice Thrown when `percentageToClaim + percentageToStake > 100`.
    error PctSumExceeded();

    /// @notice Thrown when staking is requested but no staking contract is configured.
    error NoStaking();

    /// @notice Thrown when the requested lockup period is shorter than the minimum.
    error LockupTooShort();

    /// @notice Thrown when an invalid (zero) optionId is provided.
    error InvalidOptionId();

    /// @notice Thrown if a claim is attempted after the airdrop has been ended.
    error AirdropNotActive();

    /// @notice Thrown when a user attempts to claim more than once.
    error AlreadyClaimed();

    /// @notice Thrown when the provided Merkle proof does not verify.
    error InvalidProof();

    // ───────────── Read-only Accessors ───────────────────────────

    /// @notice Merkle root for this airdrop.
    function root() external view returns (bytes32);

    /// @notice ERC-20 token being distributed.
    function tokenAsset() external view returns (address);

    /// @notice Optional staking contract.
    function stakingAddress() external view returns (ILinearStake);

    /// @notice On-chain multiplier for off-chain point calculations.
    function multiplier() external view returns (uint256);

    /// @notice Total tokens claimed so far by all users.
    function totalClaimed() external view returns (uint256);

    /// @notice Total tokens staked so far by all users.
    function totalStaked() external view returns (uint256);

    /// @notice Total bonus tokens distributed so far.
    function totalBonusTokens() external view returns (uint256);

    /// @notice Minimum lockup period (in seconds).
    function minLockupDuration() external view returns (uint32);

    /// @notice Lockup threshold to qualify for multiplier.
    function minLockupDurationForMultiplier() external view returns (uint32);

    /// @notice Whether the airdrop is still active.
    function isActive() external view returns (bool);

    /// @notice Whether the contract is currently paused.
    function paused() external view returns (bool);

    /// @notice Amount already claimed by a given user.
    function claimedAmount(address user) external view returns (uint256);

    /// @notice Validates a set of ClaimOptions without changing state.
    function validateClaimOptions(ClaimOptions calldata options) external view;

    // ───────────── State-changing Functions ───────────────────────

    /**
     * @notice Claim a portion of your allocation and optionally stake it.
     * @param beneficiary     The end user receiving tokens.
     * @param id              The airdrop ID.
     * @param proof           Merkle proof for (beneficiary, totalAllocation).
     * @param totalAllocation Full allocation as in your off-chain tree.
     * @param options         Percentages + lockup + off-chain optionId.
     * @param signature       EIP-712 signature over the ClaimRequest.
     * @return amountClaimed  Tokens sent immediately to beneficiary.
     * @return amountStaked   Tokens forwarded and staked on their behalf.
     */
    function claimFor(
        address beneficiary,
        bytes32 id,
        bytes32[] calldata proof,
        uint256 totalAllocation,
        ClaimOptions calldata options,
        bytes calldata signature
    ) external returns (uint256 amountClaimed, uint256 amountStaked);

    /// @notice Update on-chain multiplier (router only).
    function setMultiplier(uint256 newMultiplier) external;

    /// @notice End the airdrop and return remaining tokens (router only).
    function endAirdrop(address to) external;

    /// @notice Pause claim functionality (router only).
    function pause() external;

    /// @notice Unpause claim functionality (router only).
    function unpause() external;
}