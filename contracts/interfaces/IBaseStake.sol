// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

/// @notice Base interface for all stake contracts. Custom stake contracts must inherit from this.
/// @dev This interface defines the minimum required functions for any staking contract
/// that integrates with the SnagAirdrop system. Custom staking contracts must implement
/// these functions to ensure compatibility with the airdrop claim process.
interface IBaseStake {
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
     * @notice Get claimable amounts for a specific user and optionally a specific stake.
     * @param stakeId Specific stake ID to query, or 0 to query all stakes
     * @param account The address of the user to query
     * @return stakeIds Array of stake IDs that have claimable amounts
     * @return amounts Array of claimable amounts corresponding to each stake ID
     * @dev This function returns information about tokens that can be claimed by a user.
     * 
     * If stakeId is 0, returns data for all stakes owned by the account.
     * If stakeId is non-zero, returns data only for that specific stake.
     * 
     * The returned arrays are parallel - stakeIds[i] corresponds to amounts[i].
     * 
     * Example usage:
     * ```solidity
     * // Get all claimable amounts for a user
     * (uint256[] memory ids, uint256[] memory amounts) = 
     *     stakingContract.claimable(0, userAddress);
     * 
     * // Get claimable amount for specific stake
     * (uint256[] memory ids, uint256[] memory amounts) = 
     *     stakingContract.claimable(stakeId, userAddress);
     * 
     * // Calculate total claimable
     * uint256 totalClaimable = 0;
     * for (uint i = 0; i < amounts.length; i++) {
     *     totalClaimable += amounts[i];
     * }
     * ```
     */
    function claimable(uint256 stakeId, address account)
        external
        view
        returns (uint256[] memory stakeIds, uint256[] memory amounts);
}