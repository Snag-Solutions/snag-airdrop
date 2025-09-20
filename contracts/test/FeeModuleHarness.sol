// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "../../contracts/modules/SnagFeeModule.sol";

/// @dev Minimal harness to expose SnagFeeModule internals for unit tests.
contract FeeModuleHarness is SnagFeeModule {
    // initializer passthrough
    function init(
        address priceFeed_,
        uint32  maxPriceAge_,
        address protocolTreasury_,
        address protocolOverflow_,
        address partnerOverflow_,
        uint64  feeClaimUsdCents_,
        uint64  feeStakeUsdCents_,
        uint64  feeCapUsdCents_,
        FeeOverflowMode overflowMode_,
        uint16  protocolTokenShareBips_
    ) external {
        __snagFee_init(
            priceFeed_,
            maxPriceAge_,
            protocolTreasury_,
            protocolOverflow_,
            partnerOverflow_,
            feeClaimUsdCents_,
            feeStakeUsdCents_,
            feeCapUsdCents_,
            overflowMode_,
            protocolTokenShareBips_
        );
    }

    // expose views
    function reqFee(bool stakeSelected) external view returns (uint256) {
        return requiredFeeWei(stakeSelected);
    }

    function capHeadroom() external view returns (uint64) {
        return remainingFeeCapUsdCents();
    }

    function protoShare(uint256 distributed) external view returns (uint256) {
        return _protocolShare(distributed);
    }

    // expose mutators
    function collect(bool stakeSelected) external payable returns (address, uint256) {
        return _collectUserFee(stakeSelected);
    }

    function setTotalUsd(uint64 v) external { totalFeeUsdCents = v; }

    function setAccrued(uint256 v) external { protocolAccruedTokens = v; }

    function rotatePartner(address next) external { _updatePartnerOverflow(next); }

    function markWithdraw(address to, uint256 amt) external { _markProtocolWithdraw(to, amt); }

    // allow receiving refunds
    receive() external payable {}
}