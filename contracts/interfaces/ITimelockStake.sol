// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "./IBaseStake.sol";

/// @notice Timelock staking interface (cliff unlock at end of duration).
/// @dev Extends IBaseStake with claim & enumeration helpers.
interface ITimelockStake is IBaseStake {
    /**
     * @notice Claim tokens from a matured stake (or all matured stakes).
     * @param stakeId Specific stake ID to claim from, or 0 to claim from all matured stakes owned by the caller.
     * @return totalClaimed Total amount of tokens transferred to the caller.
     */
    function claim(uint256 stakeId) external returns (uint256 totalClaimed);

    /**
     * @notice Claim matured stakes in batches, starting after a cursor.
     * @param startAfterId Stake ID cursor. Use 0 to start from the beginning. If non-zero, must be owned by caller.
     * @param maxStakes Maximum number of stakes to attempt to claim in this call.
     * @return totalClaimed Total amount claimed in this batch.
     * @return lastProcessedId The last stake ID processed (use as cursor for next batch).
     */
    function claimFrom(uint256 startAfterId, uint256 maxStakes)
        external
        returns (uint256 totalClaimed, uint256 lastProcessedId);

    /**
     * @notice Get all stake IDs owned by a specific account.
     * @param account The address to query.
     * @return stakeIds Array of stake IDs.
     */
    function getStakeIds(address account) external view returns (uint256[] memory stakeIds);

    /// ───────────── Events ─────────────────────────────────────────

    /// @notice Emitted when a user creates a new timelock stake.
    /// @param user The address of the staker.
    /// @param stakeId The unique stake identifier.
    /// @param amount Amount of tokens locked.
    /// @param duration Lock duration in seconds.
    event Staked(address indexed user, uint256 indexed stakeId, uint256 amount, uint32 duration);

    /// @notice Emitted when a user claims a matured stake.
    /// @param user The claimant address.
    /// @param amount Amount transferred to the claimant.
    event Claimed(address indexed user, uint256 amount);

    /// @notice Emitted after a batch claim processes a set of matured stakes.
    /// @param user The address performing the batch claim.
    /// @param totalClaimed Total amount transferred in this batch.
    /// @param lastProcessedId The last stake id processed in this batch.
    event BatchClaimed(address indexed user, uint256 totalClaimed, uint256 lastProcessedId);
}
