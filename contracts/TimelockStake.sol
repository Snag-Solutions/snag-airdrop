// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { ERC165 } from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IBaseStake } from "./interfaces/IBaseStake.sol";
import { ITimelockStake } from "./interfaces/ITimelockStake.sol";

error AmountMustBePositive();
error DurationMustBePositive();
error StakeDoesNotExist();
error StakeNotMatured();
error StakeAlreadyClaimed();
error TokenCannotBeZero();
// Removed per-request: no per-account max stakes limit

/// @title TimelockStake
/// @author Snag
/// @notice Locks tokens for a fixed duration; 100% becomes claimable at maturity.
/// @dev Compatible with Snag Airdrop flow via `stakeFor`.
contract TimelockStake is Context, ERC165, ReentrancyGuard, ITimelockStake {
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    /// @dev Per-stake data packed sensibly for gas.
    struct StakeInfo {
        uint256 amount;       // total locked
        uint32  duration;     // seconds
        uint256  startTime;    // unix seconds
        bool    claimed;      // claimed once at maturity
    }

    // account => (stakeId => StakeInfo)
    mapping(address => mapping(uint256 => StakeInfo)) private _stakes;
    // account => next id (monotonic)
    mapping(address => uint256) private _stakeCounter;
    // account => set of ids
    mapping(address => EnumerableSet.UintSet) private _stakeIds;

    /// @param _token ERC20 token to lock.
    constructor(address _token) {
        if (_token == address(0)) revert TokenCannotBeZero();
        token = IERC20(_token);
    }

    /// @inheritdoc IBaseStake
    function stakeFor(address staker, uint256 amount, uint32 duration) external override nonReentrant {
        if (amount == 0) revert AmountMustBePositive();
        if (duration == 0) revert DurationMustBePositive();

        // Pull tokens from caller (claim contract).
        token.safeTransferFrom(_msgSender(), address(this), amount);

        uint256 newId = ++_stakeCounter[staker];
        _stakes[staker][newId] = StakeInfo({
            amount:   amount,
            duration: duration,
            startTime: block.timestamp,
            claimed:  false
        });
        _stakeIds[staker].add(newId);

        emit Staked(staker, newId, amount, duration);
    }

    /// @inheritdoc ITimelockStake
    function claim(uint256 stakeId) external override nonReentrant returns (uint256 totalClaimed) {
        EnumerableSet.UintSet storage set_ = _stakeIds[_msgSender()];

        if (stakeId != 0) {
            if (!set_.contains(stakeId)) revert StakeDoesNotExist();
            totalClaimed = _claimSingle(_msgSender(), stakeId);
        } else {
            uint256 len = set_.length();
            for (uint256 i = 0; i < len; i++) {
                uint256 id = set_.at(i);
                // Try-claim matured stakes only; skip otherwise.
                uint256 claimedAmt = _claimSingleIfMature(_msgSender(), id);
                totalClaimed += claimedAmt;
            }
        }

        // If nothing was claimable in a specific-claim call, revert with a helpful error.
        if (stakeId != 0 && totalClaimed == 0) {
            StakeInfo memory s = _stakes[_msgSender()][stakeId];
            if (s.claimed) revert StakeAlreadyClaimed();
            revert StakeNotMatured();
        }
    }

    /// @inheritdoc ITimelockStake
    function claimFrom(uint256 startAfterId, uint256 maxStakes)
        external
        nonReentrant
        returns (uint256 totalClaimed, uint256 lastProcessedId)
    {
        EnumerableSet.UintSet storage set_ = _stakeIds[_msgSender()];
        uint256 len = set_.length();
        if (len == 0 || maxStakes == 0) return (0, startAfterId);

        // Find starting index from cursor
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
            uint256 claimedAmt = _claimSingleIfMature(_msgSender(), id);
            totalClaimed += claimedAmt;
        }

        if (lastProcessedId != 0) {
            emit BatchClaimed(_msgSender(), totalClaimed, lastProcessedId);
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
            ids = new uint256[](1);
            amts = new uint256[](1);
            ids[0] = stakeId;
            amts[0] = _claimableSingle(account, stakeId);
        } else {
            uint256 len = set_.length();
            ids = new uint256[](len);
            amts = new uint256[](len);
            for (uint256 i = 0; i < len; i++) {
                uint256 id = set_.at(i);
                ids[i]  = id;
                amts[i] = _claimableSingle(account, id);
            }
        }
    }

    /// @inheritdoc ITimelockStake
    function getStakeIds(address account) external view override returns (uint256[] memory) {
        return _stakeIds[account].values();
    }

    // ───────────── Internal helpers ────────────────────────────────

    function _claimSingle(address acct, uint256 id) private returns (uint256) {
        StakeInfo storage s = _stakes[acct][id];

        if (s.amount == 0) revert StakeDoesNotExist();
        if (s.claimed)     revert StakeAlreadyClaimed();

        // Mature when now >= start + duration.
        if (block.timestamp < uint256(s.startTime) + uint256(s.duration)) {
            revert StakeNotMatured();
        }

        s.claimed = true; // effects
        uint256 amt = uint256(s.amount);
        token.safeTransfer(acct, amt); // interaction
        emit Claimed(acct, amt);
        return amt;
    }

    function _claimSingleIfMature(address acct, uint256 id) private returns (uint256) {
        StakeInfo storage s = _stakes[acct][id];
        if (s.amount == 0 || s.claimed) return 0;
        if (block.timestamp < uint256(s.startTime) + uint256(s.duration)) return 0;

        s.claimed = true;
        uint256 amt = uint256(s.amount);
        token.safeTransfer(acct, amt);
        emit Claimed(acct, amt);
        return amt;
    }

    function _claimableSingle(address acct, uint256 id) private view returns (uint256) {
        StakeInfo storage s = _stakes[acct][id];
        if (s.amount == 0 || s.claimed) return 0;
        if (block.timestamp >= uint256(s.startTime) + uint256(s.duration)) {
            return uint256(s.amount);
        }
        return 0;
    }

    // ───────────── ERC165 ─────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC165)
        returns (bool)
    {
        return
            interfaceId == type(ITimelockStake).interfaceId ||
            interfaceId == type(IBaseStake).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
