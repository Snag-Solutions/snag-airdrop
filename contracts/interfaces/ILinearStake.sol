// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

import "./IBaseStake.sol";

/// @notice Full interface for the linear‐unlock staking contract, including events.
/// @dev This interface extends IBaseStake with additional functionality specific to
/// linear vesting staking contracts. The LinearStake contract implements linear
/// vesting over time, allowing users to claim tokens as they become unlocked.
interface ILinearStake is IBaseStake {

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
     * @notice Claim unlocked tokens from an explicit list of stake IDs.
     * @param ids Array of stake IDs owned by the caller to process.
     * @return totalClaimed Total amount of tokens transferred to the caller.
     */
    function claimUnlockedIds(uint256[] calldata ids) external returns (uint256 totalClaimed);

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

    /// @notice Emitted when a user claims vested tokens from a specific stake.
    /// @param user The address of the user who claimed tokens
    /// @param stakeId The stake ID that was claimed from
    /// @param amount The amount of tokens claimed
    /// @dev This event provides a record of token claims for tracking and analytics.
    event Claimed(address indexed user, uint256 indexed stakeId, uint256 amount);

    /// @notice Emitted after a batch claim processes a set of stakes.
    /// @param user The address performing the batch claim
    /// @param totalClaimed The total amount transferred in this batch
    /// @param lastProcessedId The last stake id processed in this batch
    event BatchClaimed(address indexed user, uint256 totalClaimed, uint256 lastProcessedId);
}
