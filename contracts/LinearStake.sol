// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/ILinearStake.sol";

error AmountMustBePositive();
error DurationMustBePositive();
error TransferFailed();
error StakeDoesNotExist();

contract LinearStake is Context, ERC165, ILinearStake {
    using EnumerableSet for EnumerableSet.UintSet;
    IERC20 public immutable token;

    struct StakeInfo { uint256 amount; uint32 duration; uint256 startTime; uint256 claimed; }
    mapping(address => mapping(uint256 => StakeInfo)) private _stakes;
    mapping(address => uint256)                  private _stakeCounter;
    mapping(address => EnumerableSet.UintSet)    private _stakeIds;

    constructor(address _token) { token = IERC20(_token); }

    function stakeFor(address staker, uint256 amount, uint32 duration) external override {
        if (amount == 0)       revert AmountMustBePositive();
        if (duration == 0)     revert DurationMustBePositive();
        if (!token.transferFrom(_msgSender(), address(this), amount)) revert TransferFailed();

        _stakeCounter[staker] += 1;
        uint256 id = _stakeCounter[staker];
        _stakes[staker][id] = StakeInfo(amount, duration, block.timestamp, 0);
        _stakeIds[staker].add(id);
        emit Staked(staker, id, amount, duration);
    }

    function claimUnlocked(uint256 stakeId) external override returns (uint256 totalClaimed) {
        EnumerableSet.UintSet storage set_ = _stakeIds[_msgSender()];
        if (stakeId != 0) {
            if (!set_.contains(stakeId)) revert StakeDoesNotExist();
            totalClaimed = _claimUnlockedSingle(_msgSender(), stakeId);
        } else {
            uint256 len = set_.length();
            for (uint256 i = 0; i < len; i++) {
                totalClaimed += _claimUnlockedSingle(_msgSender(), set_.at(i));
            }
        }
    }

    function claimable(uint256 stakeId, address account)
        external
        view
        override
        returns (uint256[] memory ids, uint256[] memory amts)
    {
        EnumerableSet.UintSet storage set_ = _stakeIds[account];
        uint256 len = set_.length();
        if (stakeId != 0) {
            ids  = new uint256[](1);
            amts = new uint256[](1);
            ids[0]  = stakeId;
            amts[0] = _claimableSingle(account, stakeId);
        } else {
            ids  = new uint256[](len);
            amts = new uint256[](len);
            for (uint256 i = 0; i < len; i++) {
                uint256 id_ = set_.at(i);
                ids[i]      = id_;
                amts[i]     = _claimableSingle(account, id_);
            }
        }
    }

    function _claimUnlockedSingle(address acct, uint256 id) private returns (uint256) {
        StakeInfo storage s = _stakes[acct][id];
        uint256 to = _claimableSingle(acct, id);
        if (to == 0) return 0;
        s.claimed += to;
        if (!token.transfer(acct, to)) revert TransferFailed();
        emit Claimed(acct, to);
        return to;
    }

    function _claimableSingle(address acct, uint256 id) private view returns (uint256) {
        StakeInfo storage s = _stakes[acct][id];
        if (s.amount == 0 || block.timestamp <= s.startTime) return 0;
        uint256 elapsed = block.timestamp - s.startTime;
        uint256 vested  = elapsed >= s.duration ? s.amount : (s.amount * elapsed) / s.duration;
        return vested > s.claimed ? vested - s.claimed : 0;
    }

    function getStakeIds(address account) external view override returns (uint256[] memory) {
        return _stakeIds[account].values();
    }

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