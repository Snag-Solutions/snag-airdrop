// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import "./IBaseStake.sol";

/// @notice Full interface for the linear‐unlock staking contract, including events.
interface ILinearStake is IBaseStake {
    /// @notice Pull down all unlocked tokens for `msg.sender`.
    /// @param stakeId Specific stake to claim or zero for all.
    /// @return totalClaimed Total tokens transferred to the caller.
    function claimUnlocked(uint256 stakeId) external returns (uint256 totalClaimed);

    /// @notice List all of `account`'s stake IDs.
    /// @param account  Address to query.
    /// @return stakeIds List of active stake IDs.
    function getStakeIds(address account) external view returns (uint256[] memory stakeIds);

    /// @notice Emitted when a user stakes tokens.
    event Staked(address indexed user, uint256 indexed stakeId, uint256 amount, uint32 duration);

    /// @notice Emitted when a user claims vested tokens.
    event Claimed(address indexed user, uint256 amount);
}