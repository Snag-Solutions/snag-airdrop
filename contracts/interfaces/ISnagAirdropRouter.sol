// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import {ISnagAirdropClaim} from "./ISnagAirdropClaim.sol";

/// @notice Interface for the central airdrop router + factory, including custom errors.
interface ISnagAirdropRouter {
    // ───────────── Errors ─────────────────────────────────────────

    /// @notice Thrown when trying to deploy a claim contract with an ID that already exists.
    error IdExists();

    /// @notice Thrown when the provided admin address is the zero address.
    error ZeroAdmin();

    /// @notice Thrown when the override staking address does not implement IBaseStake.
    error InvalidStakingAddress();

    /// @notice Thrown when referencing an airdrop ID that has not been deployed.
    error InvalidId();

    /// @notice Thrown when the caller is not the configured airdrop admin.
    error NotAirdropAdmin();

    // ───────────── Data Types ───────────────────────────────────────

    /// @notice Data returned by `getClaimData`.
    struct ClaimData {
        uint256 totalClaimed;
        uint256 claimedByUser;
        uint256 totalStaked;
        uint256 totalBonusTokens;
        uint32   minLockupDuration;
        uint32   minLockupDurationForMultiplier;
        uint256 multiplier;
        bool    isActive;
        bool    isPaused;
        address tokenAsset;
        address stakingAddress;
        address admin;
    }

    // ───────────── Events ──────────────────────────────────────────

    /// @notice Emitted when a new claim contract is deployed.
    event ClaimContractDeployed(
        bytes32 indexed id,
        bytes32 indexed root,
        address indexed claimContract,
        address stakingAddress,
        address admin
    );

    /// @notice Emitted when a user claims tokens.
    event Claimed(
        bytes32 indexed id,
        address indexed claimer,
        uint256 amountClaimed,
        uint256 amountStaked,
        uint8  percentageToClaim,
        uint8  percentageToStake,
        uint32 lockupPeriod,
        uint256 multiplier
    );

    // ───────────── Read Functions ─────────────────────────────────

    /// @notice Returns the claim contract for a given airdrop ID.
    function claimContractById(bytes32 id) external view returns (address);

    /// @notice Returns the admin for a given airdrop ID.
    function airdropAdmin(bytes32 id) external view returns (address);

    // ───────────── Write Functions ────────────────────────────────

    /// @notice Deploy a new airdrop with optional staking support.
    function deployClaimContract(
        bytes32 id,
        bytes32 root,
        address assetAddress,
        address admin,
        uint256 multiplier,
        bool    withStaking,
        address overrideStakingAddress,
        uint32  minLockupDuration,
        uint32  minLockupDurationForMultiplier
    ) external returns (address);

    /// @notice Claim and optionally stake tokens in a single call.
    function claim(
        bytes32 id,
        bytes32[] calldata proof,
        uint256 totalAllocation,
        ISnagAirdropClaim.ClaimOptions calldata options,
        bytes calldata signature
    ) external;

    /// @notice Returns the staking contract address for a given airdrop ID.
    function getStakingAddress(bytes32 id) external view returns (address);

    /// @notice Returns aggregated airdrop stats plus the caller’s claimed amount.
    function getClaimData(bytes32 id, address account)
        external
        view
        returns (ClaimData memory);

    /// @notice Returns per-user stake IDs, claimable amounts, and total claimable.
    function getStakingData(
        bytes32 id,
        address account
    )
        external
        view
        returns (
            uint256[] memory stakeIds,
            uint256[] memory claimableAmounts,
            uint256 totalClaimable
        );

    /// @notice Update the on-chain multiplier (admin only).
    function setMultiplier(bytes32 id, uint256 newMultiplier) external;

    /// @notice End the airdrop and transfer remaining tokens (admin only).
    function endAirdrop(bytes32 id, address to) external;

    /// @notice Pause the claim functionality (admin only).
    function pause(bytes32 id) external;

    /// @notice Unpause the claim functionality (admin only).
    function unpause(bytes32 id) external;
}