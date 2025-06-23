// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

/// @notice Base interface for all stake contracts. Custom stake contracts must inherit from this.
interface IBaseStake {
    /// @notice Stake `amount` on behalf of `staker`, locked for `duration` seconds.
    function stakeFor(address staker, uint256 amount, uint32 duration) external;

    /// @notice How many tokens are currently claimable for `account`.
    /// @param stakeId  Specific stake or zero to query all.
    /// @param account  User address to query.
    /// @return stakeIds  Array of stake IDs.
    /// @return amounts   Corresponding claimable amounts.
    function claimable(uint256 stakeId, address account)
      external
      view
      returns (uint256[] memory stakeIds, uint256[] memory amounts);
}