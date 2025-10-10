// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {PriceLib} from "../libs/PriceLib.sol";
import "../errors/Errors.sol";
import {AggregatorV3Interface} from "../vendor/AggregatorV3Interface.sol";
import {Context} from '@openzeppelin/contracts/utils/Context.sol';

/// @title SnagFeeModule
/// @notice Reusable fee & token-share module for Claim contracts.
/// @dev Holds and enforces:
///      - USD-pegged per-claim/per-stake fees
///      - Cap + overflow behavior
///      - Protocol token-share accrual
abstract contract SnagFeeModule is Context {
    struct InitFeeConfig {
        address priceFeed;
        uint32  maxPriceAge;
        address protocolTreasury;
        address protocolOverflow;
        address partnerOverflow;
        uint64  feeClaimUsdCents;
        uint64  feeStakeUsdCents;
        uint64  feeCapUsdCents;
        FeeOverflowMode overflowMode;
        uint16  protocolTokenShareBips;
    }
    /// @notice Behavior once the USD-fee cap is reached.
    enum FeeOverflowMode { Cancel, RouteToPartner, RouteToProtocol }

    // ---- Immutable-by-convention once initialized ----
    address internal _priceFeed;                 // native/USD feed
    uint32  internal _maxPriceAge;               // seconds

    address public  protocolTreasury;            // receiver pre-cap
    address public  protocolOverflow;            // receiver post-cap (protocol)
    address public  partnerOverflow;             // receiver post-cap (partner, rotatable by partner)

    uint64  public  feeClaimUsdCents;            // 0=off
    uint64  public  feeStakeUsdCents;            // 0=off
    uint64  public  feeCapUsdCents;              // 0=no cap
    uint64  public  totalFeeUsdCents;            // cumulative (pre-cap only)
    FeeOverflowMode public overflowMode;

    uint16  public  protocolTokenShareBips;      // 0..10000
    uint256 public  protocolAccruedTokens;       // custody inside claim

    // Intentionally no events in the module; parent contracts (e.g., Claim)
    // should emit higher-level events with fee context when appropriate.

    /// @dev Module initializer (call once from parent.initialize).
    function __snagFee_init(InitFeeConfig memory cfg) internal {
        _priceFeed             = cfg.priceFeed;
        _maxPriceAge           = cfg.maxPriceAge;
        protocolTreasury       = cfg.protocolTreasury;
        protocolOverflow       = cfg.protocolOverflow;
        partnerOverflow        = cfg.partnerOverflow;
        feeClaimUsdCents       = cfg.feeClaimUsdCents;
        feeStakeUsdCents       = cfg.feeStakeUsdCents;
        feeCapUsdCents         = cfg.feeCapUsdCents;
        overflowMode           = cfg.overflowMode;
        protocolTokenShareBips = cfg.protocolTokenShareBips;
    }

    /// @notice Remaining USD-cap headroom (0 if cap reached or no cap configured).
    function remainingFeeCapUsdCents() public view returns (uint64) {
        return totalFeeUsdCents >= feeCapUsdCents ? 0 : (feeCapUsdCents - totalFeeUsdCents);
    }

    /// @notice Exact wei required for current fee state (0 if disabled or post-cap Cancel).
    function requiredFeeWei(bool stakeSelected) public view returns (uint256) {
        uint64 usd = stakeSelected ? feeStakeUsdCents : feeClaimUsdCents;
        if (usd == 0) return 0;
        if (totalFeeUsdCents >= feeCapUsdCents && overflowMode == FeeOverflowMode.Cancel) return 0;
        return PriceLib.usdCentsToWei(_priceFeed, _maxPriceAge, usd);
    }

    /// @dev Internal: partner can rotate their overflow address.
    function _updatePartnerOverflow(address next) internal {
        partnerOverflow = next;
    }

    /// @dev Internal: bookkeeping when protocol token share is withdrawn.
    function _markProtocolWithdraw(address /*to*/, uint256 amt) internal {
        protocolAccruedTokens -= amt; // bound-checked by caller
    }

    /// @dev Collect user fee according to cap/mode; emits events; refunds dust.
    /// @return receiver Destination address used
    /// @return paidWei  Wei actually sent to receiver
    function _collectUserFee(bool stakeSelected) internal returns (address receiver, uint256 paidWei) {
        uint64 usd = stakeSelected ? feeStakeUsdCents : feeClaimUsdCents;
        if (usd == 0) { _refundIfAny(); return (address(0), 0); }

        if (totalFeeUsdCents >= feeCapUsdCents) {
            if (overflowMode == FeeOverflowMode.Cancel) { _refundIfAny(); return (address(0), 0); }
            receiver = (overflowMode == FeeOverflowMode.RouteToPartner) ? partnerOverflow : protocolOverflow;
            uint256 feeWei = PriceLib.usdCentsToWei(_priceFeed, _maxPriceAge, usd);
            _takeFee(receiver, feeWei);
            paidWei = feeWei;
            return (receiver, paidWei);
        }

        receiver = protocolTreasury;
        uint256 feeWei2 = PriceLib.usdCentsToWei(_priceFeed, _maxPriceAge, usd);
        _takeFee(receiver, feeWei2);
        totalFeeUsdCents += usd;
        paidWei = feeWei2;
    }

    /// @dev Takes exactly `needWei`; refunds dust; reverts on underpay or failed transfers.
    function _takeFee(address to, uint256 needWei) private {
        if (msg.value < needWei) revert InsufficientFee();
        unchecked {
            uint256 refund = msg.value - needWei;
            (bool ok,) = payable(to).call{value: needWei}("");
            if (!ok) revert FeeTransferFailed();
            if (refund > 0) {
                (bool ok2,) = payable(_msgSender()).call{value: refund}("");
                if (!ok2) revert RefundFailed();
            }
        }
    }

    /// @dev Refunds full msg.value when fee is disabled/waived.
    function _refundIfAny() private {
        if (msg.value > 0) {
            (bool ok,) = payable(_msgSender()).call{value: msg.value}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @dev Latest oracle price (for event context only).
    function _lastPrice() private view returns (int256 p) {
        (,p,,,) = AggregatorV3Interface(_priceFeed).latestRoundData();
    }

    /// @dev Ceil( distributed * bips / 10000 ).
    function _protocolShare(uint256 distributed) internal view returns (uint256) {
        if (protocolTokenShareBips == 0 || distributed == 0) return 0;
        uint256 num = distributed * uint256(protocolTokenShareBips);
        return (num + 9999) / 10000;
    }
}
