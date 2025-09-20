// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {SnagFeeModule} from "../modules/SnagFeeModule.sol";

contract MockFeeModuleHarness is SnagFeeModule {
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

    function exposedRequiredFeeWei(bool stakeSelected) external view returns (uint256) {
        return requiredFeeWei(stakeSelected);
    }

    function exposedRemainingCap() external view returns (uint64) {
        return remainingFeeCapUsdCents();
    }

    function exposedUpdatePartnerOverflow(address next) external {
        _updatePartnerOverflow(next);
    }

    function exposedCollect(bool stakeSelected) external payable returns (address receiver, uint256 weiPaid) {
        return _collectUserFee(stakeSelected);
    }
}

