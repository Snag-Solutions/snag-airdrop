// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {ILinearStake} from "./ILinearStake.sol";

/// @notice Interface for the SnagAirdropClaim contract, including all errors and events.
/// @dev This contract handles the core airdrop functionality including claim verification,
/// token distribution, staking integration, and bonus multiplier calculations.
interface ISnagAirdropClaim {
    /// @dev Mirrors the ClaimOptions struct in SnagAirdropClaim.
    /// @notice Configuration options for claiming tokens from an airdrop.
    struct ClaimOptions {
        bytes32 optionId;        /// Unique identifier for the claim option (must be non-zero)
        uint8  percentageToClaim; /// Percentage of allocation to claim immediately (0-100)
        uint8  percentageToStake; /// Percentage of allocation to stake (0-100)
        uint32 lockupPeriod;     /// Lockup duration in seconds for staked tokens
    }

    // ───────────── Events ─────────────────────────────────────────

    /// @notice Emitted when the multiplier is updated by the router.
    /// @param oldMultiplier The previous multiplier value in basis points
    /// @param newMultiplier The new multiplier value in basis points
    /// @dev This event provides an audit trail for multiplier changes.
    event MultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);

    /// @notice Emitted when the airdrop is ended and remaining tokens are transferred.
    /// @param to The address receiving the remaining tokens
    /// @param amount The amount of tokens transferred
    /// @dev This event is indexed by the recipient address for efficient filtering.
    event AirdropEnded(address indexed to, uint256 amount);

    // ───────────── Errors ─────────────────────────────────────────

    /// @notice Thrown when contract balance is insufficient for a transfer.
    /// @param required  Amount that was required for the operation
    /// @param available Amount actually available in the contract
    /// @dev This error occurs when the contract doesn't have enough tokens to fulfill a claim or stake.
    error OutOfTokens(uint256 required, uint256 available);

    /// @notice Thrown when a function guarded by `onlyRouter` is called by a non-router.
    /// @dev This error ensures that only the authorized router contract can call certain functions.
    error OnlyRouter();

    /// @notice Thrown if the EIP-712 signature does not match the expected beneficiary.
    /// @dev This error occurs when the signature verification fails, preventing unauthorized claims.
    error InvalidSignature();

    /// @notice Thrown when `percentageToClaim + percentageToStake > 100`.
    /// @dev This error ensures that the total percentage does not exceed 100%.
    error PctSumExceeded();

    /// @notice Thrown when staking is requested but no staking contract is configured.
    /// @dev This error occurs when a user tries to stake tokens but no staking contract is available.
    error NoStaking();

    /// @notice Thrown when the requested lockup period is shorter than the minimum.
    /// @dev This error ensures that staking lockup periods meet the minimum requirement.
    error LockupTooShort();

    /// @notice Thrown when an invalid (zero) optionId is provided.
    /// @dev This error ensures that all claims have a valid option identifier for tracking.
    error InvalidOptionId();

    /// @notice Thrown if a claim is attempted after the airdrop has been ended.
    /// @dev This error prevents claims after the airdrop has been permanently ended.
    error AirdropNotActive();

    /// @notice Thrown when a user attempts to claim more than once.
    /// @dev This error ensures that each user can only claim once per airdrop.
    error AlreadyClaimed();

    /// @notice Thrown when the provided Merkle proof does not verify.
    /// @dev This error occurs when the Merkle proof is invalid or doesn't match the expected allocation.
    error InvalidProof();

    // ───────────── Read-only Accessors ───────────────────────────

    /// @notice Returns the Merkle root for this airdrop.
    /// @return The Merkle root used for claim verification
    /// @dev This root is used to verify that a user's allocation is included in the airdrop.
    function root() external view returns (bytes32);

    /// @notice Returns the ERC-20 token address being distributed.
    /// @return The address of the token contract
    /// @dev This is the token that users will receive when they claim.
    function tokenAsset() external view returns (address);

    /// @notice Returns the optional staking contract address.
    /// @return The address of the staking contract, or address(0) if no staking is enabled
    /// @dev If staking is enabled, this contract handles the vesting of staked tokens.
    function stakingAddress() external view returns (ILinearStake);

    /// @notice Returns the current bonus multiplier in basis points.
    /// @return The multiplier value (e.g., 1000 = 10% bonus)
    /// @dev This multiplier is applied to staked tokens that meet the minimum lockup requirement.
    function multiplier() external view returns (uint256);

    /// @notice Returns the total tokens claimed so far by all users.
    /// @return The total amount of tokens claimed across all users
    /// @dev This tracks the total distribution of tokens from this airdrop.
    function totalClaimed() external view returns (uint256);

    /// @notice Returns the total tokens staked so far by all users.
    /// @return The total amount of tokens staked across all users
    /// @dev This tracks the total amount of tokens currently in staking contracts.
    function totalStaked() external view returns (uint256);

    /// @notice Returns the total bonus tokens distributed so far.
    /// @return The total amount of bonus tokens distributed via multiplier
    /// @dev This tracks the total bonus tokens given to users who qualified for the multiplier.
    function totalBonusTokens() external view returns (uint256);

    /// @notice Returns the minimum lockup period in seconds.
    /// @return The minimum lockup duration required for any stake
    /// @dev Users must stake for at least this duration to be eligible for staking.
    function minLockupDuration() external view returns (uint32);

    /// @notice Returns the lockup threshold to qualify for multiplier.
    /// @return The minimum lockup duration to qualify for bonus multiplier
    /// @dev Users must stake for at least this duration to receive bonus tokens.
    function minLockupDurationForMultiplier() external view returns (uint32);

    /// @notice Returns whether the airdrop is still active.
    /// @return True if the airdrop is active, false if it has been ended
    /// @dev Once an airdrop is ended, no new claims can be made.
    function isActive() external view returns (bool);

    /// @notice Returns whether the contract is currently paused.
    /// @return True if the contract is paused, false otherwise
    /// @dev When paused, users cannot claim tokens but existing stakes continue to vest.
    function paused() external view returns (bool);

    /// @notice Returns the amount already claimed by a given user.
    /// @param user The address of the user to check
    /// @return The amount of tokens already claimed by the user
    /// @dev This tracks how much a specific user has already claimed from this airdrop.
    function claimedAmount(address user) external view returns (uint256);

    /// @notice Validates a set of ClaimOptions without changing state.
    /// @param options The claim options to validate
    /// @dev This function performs all validation checks without executing the claim.
    /// It will revert if any validation fails, providing early feedback on claim options.
    /// 
    /// Validation includes:
    /// - Percentage sum must not exceed 100%
    /// - OptionId must be non-zero
    /// - If staking is requested, staking contract must be available
    /// - If staking is requested, lockup period must meet minimum requirement
    function validateClaimOptions(ClaimOptions calldata options) external view;

    // ───────────── State-changing Functions ───────────────────────

    /**
     * @notice Claim a portion of your allocation and optionally stake it.
     * @param beneficiary     The end user receiving tokens
     * @param id              The airdrop ID for tracking purposes
     * @param proof           Merkle proof for (beneficiary, totalAllocation)
     * @param totalAllocation Full allocation as in your off-chain tree
     * @param options         Percentages + lockup + off-chain optionId
     * @param signature       EIP-712 signature over the ClaimRequest
     * @return amountClaimed  Tokens sent immediately to beneficiary
     * @return amountStaked   Tokens forwarded and staked on their behalf
     * @dev This is the main claim function that handles the complete claim process.
     * 
     * The function performs the following steps:
     * 1. Verifies the EIP-712 signature matches the beneficiary
     * 2. Validates the Merkle proof for the allocation
     * 3. Ensures the user hasn't claimed before
     * 4. Validates the claim options
     * 5. Calculates amounts to claim and stake
     * 6. Applies bonus multiplier if conditions are met
     * 7. Transfers tokens to beneficiary and staking contract
     * 
     * Security features:
     * - Reentrancy protection
     * - Signature verification
     * - Merkle proof validation
     * - One-time claim enforcement
     * 
     * Example usage:
     * ```solidity
     * ClaimOptions memory options = ClaimOptions({
     *     optionId: keccak256("my-option"),
     *     percentageToClaim: 60,  // Claim 60% immediately
     *     percentageToStake: 40,  // Stake 40%
     *     lockupPeriod: 180 days  // 6-month lockup
     * });
     * 
     * (uint256 claimed, uint256 staked) = claimContract.claimFor(
     *     beneficiary,
     *     airdropId,
     *     merkleProof,
     *     totalAllocation,
     *     options,
     *     signature
     * );
     * ```
     */
    function claimFor(
        address beneficiary,
        bytes32 id,
        bytes32[] calldata proof,
        uint256 totalAllocation,
        ClaimOptions calldata options,
        bytes calldata signature
    ) external returns (uint256 amountClaimed, uint256 amountStaked);

    /**
     * @notice Update the on-chain multiplier (router only).
     * @param newMultiplier The new multiplier value in basis points
     * @dev This function allows the router to update the bonus multiplier.
     * The multiplier affects future stakes, not existing ones.
     * Only the router contract can call this function.
     * 
     * The multiplier is applied to staked tokens that meet the minimum lockup requirement.
     * For example, a multiplier of 1000 (10%) on 1000 tokens would give 100 bonus tokens.
     * 
     * Example usage:
     * ```solidity
     * // Set 20% bonus multiplier
     * claimContract.setMultiplier(2000);
     * ```
     */
    function setMultiplier(uint256 newMultiplier) external;

    /**
     * @notice End the airdrop and return remaining tokens (router only).
     * @param to The address to receive the remaining tokens
     * @dev This function permanently ends the airdrop and transfers any remaining tokens.
     * 
     * After calling this function:
     * - The airdrop becomes inactive (isActive = false)
     * - No new claims can be made
     * - All remaining tokens are transferred to the specified address
     * - Existing stakes continue to vest normally
     * 
     * Only the router contract can call this function.
     * 
     * Example usage:
     * ```solidity
     * // End airdrop and send remaining tokens to treasury
     * claimContract.endAirdrop(treasuryAddress);
     * ```
     */
    function endAirdrop(address to) external;

    /**
     * @notice Pause claim functionality (router only).
     * @dev This function pauses all claim operations for this airdrop.
     * 
     * While paused:
     * - Users cannot claim tokens
     * - Existing stakes continue to vest normally
     * - Admin functions remain available
     * - The contract can be unpaused later
     * 
     * Only the router contract can call this function.
     * Use unpause() to resume claim functionality.
     */
    function pause() external;

    /**
     * @notice Unpause claim functionality (router only).
     * @dev This function resumes claim operations for this airdrop.
     * 
     * After unpausing:
     * - Users can claim tokens again
     * - All functionality is restored
     * - The airdrop operates normally
     * 
     * Only the router contract can call this function.
     * This function can only be called if the contract is currently paused.
     */
    function unpause() external;
}