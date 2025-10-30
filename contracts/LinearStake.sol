// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { ERC165 } from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ILinearStake } from "./interfaces/ILinearStake.sol";
import { IBaseStake } from "./interfaces/IBaseStake.sol";

error AmountMustBePositive();
error DurationMustBePositive();
error StakeDoesNotExist();

/// @title LinearStake
/// @author Snag Protocol
/// @notice Linear vesting staking contract with claimable rewards
/// @dev This contract implements linear vesting where tokens become claimable
/// over time based on the lockup duration. Users can stake tokens and claim
/// their vested amounts at any time.
contract LinearStake is Context, ERC165, ILinearStake {
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeERC20 for IERC20;
    
    IERC20 public immutable token;

    /// @dev Stake information structure
    struct StakeInfo { 
        uint256 amount;      /// Total amount staked
        uint32 duration;     /// Lockup duration in seconds
        uint256 startTime;   /// When the stake was created
        uint256 claimed;     /// Amount already claimed
    }
    
    mapping(address => mapping(uint256 => StakeInfo)) private _stakes;
    mapping(address => uint256)                  private _stakeCounter;
    mapping(address => EnumerableSet.UintSet)    private _stakeIds;

    /// @notice Initialize the staking contract
    /// @param _token The ERC-20 token to be staked
    constructor(address _token) { 
        token = IERC20(_token); 
    }

    /// @inheritdoc IBaseStake
    function stakeFor(address staker, uint256 amount, uint32 duration) external override {
        if (amount == 0)       revert AmountMustBePositive();
        if (duration == 0)     revert DurationMustBePositive();
        token.safeTransferFrom(_msgSender(), address(this), amount);

        _stakeCounter[staker] += 1;
        uint256 id = _stakeCounter[staker];
        _stakes[staker][id] = StakeInfo(amount, duration, block.timestamp, 0);
        _stakeIds[staker].add(id);
        emit Staked(staker, id, amount, duration);
    }

    // Removed: claimUnlocked(stakeId). Use claimUnlockedIds or claimUnlockedFrom instead.

    /// @inheritdoc ILinearStake
    function claimUnlockedFrom(uint256 startAfterId, uint256 maxStakes)
        external
        returns (uint256 totalClaimed, uint256 lastProcessedId)
    {
        EnumerableSet.UintSet storage set_ = _stakeIds[_msgSender()];
        uint256 len = set_.length();
        if (len == 0 || maxStakes == 0) return (0, startAfterId);

        // Find starting index
        uint256 startIndex = 0;
        if (startAfterId != 0) {
            bool found = false;
            for (uint256 i = 0; i < len; i++) {
                if (set_.at(i) == startAfterId) { startIndex = i + 1; found = true; break; }
            }
            if (!found) revert StakeDoesNotExist();
            if (startIndex >= len) return (0, startAfterId);
        }

        uint256 end = startIndex + maxStakes;
        if (end > len) end = len;
        for (uint256 i = startIndex; i < end; i++) {
            uint256 id = set_.at(i);
            lastProcessedId = id;
            totalClaimed += _claimUnlockedSingle(_msgSender(), id);
        }

        if (lastProcessedId != 0) {
            emit BatchClaimed(_msgSender(), totalClaimed, lastProcessedId);
        }
    }

    /// @inheritdoc ILinearStake
    function claimUnlockedIds(uint256[] calldata ids) external override returns (uint256 totalClaimed) {
        EnumerableSet.UintSet storage set_ = _stakeIds[_msgSender()];
        uint256 l = ids.length;
        for (uint256 i = 0; i < l; i++) {
            uint256 id = ids[i];
            if (!set_.contains(id)) revert StakeDoesNotExist();
            totalClaimed += _claimUnlockedSingle(_msgSender(), id);
        }
    }

    /// @inheritdoc IBaseStake
    function claimable(uint256 stakeId, address account)
        external
        view
        override
        returns (uint256[] memory ids, uint256[] memory amts)
    {
        EnumerableSet.UintSet storage set_ = _stakeIds[account];
        if (stakeId != 0) {
            ids  = new uint256[](1);
            amts = new uint256[](1);
            ids[0]  = stakeId;
            amts[0] = _claimableSingle(account, stakeId);
        } else {
            uint256 len = set_.length();
            ids  = new uint256[](len);
            amts = new uint256[](len);
            for (uint256 i = 0; i < len; i++) {
                uint256 id_ = set_.at(i);
                ids[i]      = id_;
                amts[i]     = _claimableSingle(account, id_);
            }
        }
    }

    /// @dev Claim unlocked tokens for a single stake
    /// @param acct The account address
    /// @param id The stake ID
    /// @return The amount claimed
    function _claimUnlockedSingle(address acct, uint256 id) private returns (uint256) {
        StakeInfo storage s = _stakes[acct][id];
        uint256 to = _claimableSingle(acct, id);
        if (to == 0) return 0;
        s.claimed += to;
        token.safeTransfer(acct, to);
        emit Claimed(acct, id, to);
        return to;
    }

    /// @dev Calculate claimable amount for a single stake
    /// @param acct The account address
    /// @param id The stake ID
    /// @return The claimable amount
    function _claimableSingle(address acct, uint256 id) private view returns (uint256) {
        StakeInfo storage s = _stakes[acct][id];
        if (s.amount == 0 || block.timestamp <= s.startTime) return 0;
        uint256 elapsed = block.timestamp - s.startTime;
        uint256 vested  = elapsed >= s.duration ? s.amount : (s.amount * elapsed) / s.duration;
        return vested > s.claimed ? vested - s.claimed : 0;
    }

    /// @inheritdoc ILinearStake
    function getStakeIds(address account) external view override returns (uint256[] memory) {
        return _stakeIds[account].values();
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC165)
        returns (bool)
    {
        return
            interfaceId == type(ILinearStake).interfaceId ||
            interfaceId == type(IBaseStake).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
