// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./IBaseStake.sol";

/// @notice Full interface for the linear‐unlock staking contract, including events.
/// @dev This interface extends IBaseStake with additional functionality specific to
/// linear vesting staking contracts. The LinearStake contract implements linear
/// vesting over time, allowing users to claim tokens as they become unlocked.
interface ILinearStake is IBaseStake {
    /**
     * @notice Claim unlocked tokens from stakes.
     * @param stakeId Specific stake ID to claim from, or 0 to claim from all stakes
     * @return totalClaimed Total amount of tokens transferred to the caller
     * @dev This function allows users to claim tokens that have become unlocked
     * based on the linear vesting schedule.
     * 
     * If stakeId is 0, claims from all stakes owned by the caller.
     * If stakeId is non-zero, claims only from that specific stake.
     * 
     * The function:
     * - Calculates how many tokens have vested since the last claim
     * - Transfers the vested tokens to the caller
     * - Updates the claimed amount for each stake
     * - Emits Claimed events
     * 
     * Tokens vest linearly over the lockup period. For example, if a stake has
     * 1000 tokens with a 100-day lockup, after 50 days 500 tokens would be claimable.
     * 
     * Example usage:
     * ```solidity
     * // Claim from all stakes
     * uint256 totalClaimed = stakingContract.claimUnlocked(0);
     * 
     * // Claim from specific stake
     * uint256 claimed = stakingContract.claimUnlocked(stakeId);
     * 
     * console.log("Claimed", totalClaimed, "tokens");
     * ```
     */
    function claimUnlocked(uint256 stakeId) external returns (uint256 totalClaimed);

    /**
     * @notice Claim unlocked tokens from a batch of stakes, starting after a cursor.
     * @param startAfterId Stake ID cursor. Use 0 to start from the beginning. If non-zero, must be owned by caller.
     * @param maxStakes Maximum number of stakes to process in this call.
     * @return totalClaimed Total amount of tokens transferred to the caller in this batch.
     * @return lastProcessedId The last stake ID processed (use as cursor for next batch).
     */
    function claimUnlockedFrom(uint256 startAfterId, uint256 maxStakes)
        external
        returns (uint256 totalClaimed, uint256 lastProcessedId);

    /**
     * @notice Get all stake IDs owned by a specific account.
     * @param account The address of the user to query
     * @return stakeIds Array of all stake IDs owned by the account
     * @dev This function returns all stake IDs that belong to the specified account.
     * Stake IDs are unique identifiers assigned when stakes are created.
     * 
     * The returned array can be used to:
     * - Query specific stakes for detailed information
     * - Calculate total staked amounts
     * - Track stake creation order
     * 
     * Example usage:
     * ```solidity
     * uint256[] memory stakeIds = stakingContract.getStakeIds(userAddress);
     * 
     * console.log("User has", stakeIds.length, "stakes");
     * for (uint i = 0; i < stakeIds.length; i++) {
     *     console.log("Stake", i, "ID:", stakeIds[i]);
     * }
     * ```
     */
    function getStakeIds(address account) external view returns (uint256[] memory stakeIds);

    // ───────────── Events ─────────────────────────────────────────

    /// @notice Emitted when a user creates a new stake.
    /// @param user The address of the user who created the stake
    /// @param stakeId The unique identifier for the new stake
    /// @param amount The amount of tokens staked
    /// @param duration The lockup duration in seconds
    /// @dev This event provides a record of stake creation for tracking and analytics.
    event Staked(address indexed user, uint256 indexed stakeId, uint256 amount, uint32 duration);

    /// @notice Emitted when a user claims vested tokens.
    /// @param user The address of the user who claimed tokens
    /// @param amount The amount of tokens claimed
    /// @dev This event provides a record of token claims for tracking and analytics.
    event Claimed(address indexed user, uint256 amount);

    /// @notice Emitted after a batch claim processes a set of stakes.
    /// @param user The address performing the batch claim
    /// @param totalClaimed The total amount transferred in this batch
    /// @param lastProcessedId The last stake id processed in this batch
    event BatchClaimed(address indexed user, uint256 totalClaimed, uint256 lastProcessedId);
}
