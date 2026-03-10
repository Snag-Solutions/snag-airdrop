// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

/// @notice Base interface for all stake contracts. Custom stake contracts must inherit from this.
/// @dev This interface defines the minimum required functions for any staking contract
/// that integrates with the SnagAirdrop system. Custom staking contracts must implement
/// these functions to ensure compatibility with the airdrop claim process.
interface IBaseStake {
    /// @notice Stake information structure
    /// @param stakeId The unique identifier for the stake
    /// @param amount Total amount staked
    /// @param duration Lockup duration in seconds
    /// @param startTime When the stake was created (unix timestamp)
    /// @param claimed Amount already claimed (for linear stakes) or amount if fully claimed (for timelock stakes)
    /// @param claimable Amount that can currently be claimed
    struct StakeInfo {
        uint256 stakeId;
        uint256 amount;
        uint32 duration;
        uint256 startTime;
        uint256 claimed;
        uint256 claimable;
    }
    /**
     * @notice Stake tokens on behalf of a user with a specified lockup period.
     * @param staker The address of the user who will own the stake
     * @param amount The amount of tokens to stake
     * @param duration The lockup duration in seconds
     * @dev This function is called by the airdrop claim contract to create stakes
     * on behalf of users. The function should:
     * - Transfer tokens from the caller to the staking contract
     * - Create a new stake for the specified user
     * - Apply the specified lockup duration
     * - Emit appropriate events
     * 
     * The staking contract should handle:
     * - Token transfer validation
     * - Stake creation and tracking
     * - Lockup period enforcement
     * 
     * Example usage:
     * ```solidity
     * // Stake 1000 tokens for user with 90-day lockup
     * stakingContract.stakeFor(userAddress, 1000e18, 90 days);
     * ```
     */
    function stakeFor(address staker, uint256 amount, uint32 duration) external;

    /**
     * @notice Claim tokens from stakes in batches, starting after a cursor.
     * @param startAfterId Stake ID cursor. Use 0 to start from the beginning. If non-zero, must be owned by caller.
     * @param maxStakes Maximum number of stakes to process in this call.
     * @return totalClaimed Total amount of tokens transferred to the caller in this batch.
     * @return lastProcessedId The last stake ID processed (use as cursor for next batch).
     * @dev This function allows users to claim tokens from their stakes in a paginated manner.
     * 
     * For linear stakes: claims unlocked/vested portions that haven't been claimed yet.
     * For timelock stakes: claims the full amount if the stake has matured.
     * 
     * The function processes stakes starting after the cursor position, up to maxStakes.
     * This allows for pagination when a user has many stakes.
     * 
     * Example usage:
     * ```solidity
     * // Claim from first batch of stakes
     * (uint256 totalClaimed, uint256 lastProcessedId) = 
     *     stakingContract.claimFrom(0, 10);
     * 
     * // Continue claiming from next batch
     * (uint256 totalClaimed2, uint256 lastProcessedId2) = 
     *     stakingContract.claimFrom(lastProcessedId, 10);
     * ```
     */
    function claimFrom(uint256 startAfterId, uint256 maxStakes)
        external
        returns (uint256 totalClaimed, uint256 lastProcessedId);

    /**
     * @notice Get claimable amounts for a specific user and optionally a specific stake.
     * @param stakeId Specific stake ID to query, or 0 to query all stakes
     * @param account The address of the user to query
     * @return stakeInfos Array of StakeInfo structs containing stake details
     * @dev This function returns information about tokens that can be claimed by a user.
     * 
     * If stakeId is 0, returns data for all stakes owned by the account.
     * If stakeId is non-zero, returns data only for that specific stake.
     * 
     * Each StakeInfo struct contains:
     * - stakeId: The unique identifier for the stake
     * - amount: Total amount staked
     * - duration: Lockup duration in seconds
     * - startTime: When the stake was created (unix timestamp)
     * - claimed: Amount already claimed (for linear stakes) or amount if fully claimed (for timelock stakes)
     * - claimable: Amount that can currently be claimed
     * 
     * Example usage:
     * ```solidity
     * // Get all stake information for a user
     * IBaseStake.StakeInfo[] memory stakeInfos = 
     *     stakingContract.claimable(0, userAddress);
     * 
     * // Get specific stake information
     * IBaseStake.StakeInfo[] memory stakeInfos = 
     *     stakingContract.claimable(stakeId, userAddress);
     * 
     * // Calculate total claimable (now directly available in struct)
     * uint256 totalClaimable = 0;
     * for (uint i = 0; i < stakeInfos.length; i++) {
     *     totalClaimable += stakeInfos[i].claimable;
     * }
     * ```
     */
    function claimable(uint256 stakeId, address account)
        external
        view
        returns (StakeInfo[] memory stakeInfos);
}
