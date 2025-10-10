// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {AggregatorV3Interface} from "../vendor/AggregatorV3Interface.sol";
import {BadPrice, StalePrice, InvalidFeedDecimals} from "../errors/Errors.sol";

/// @title PriceLib
/// @notice Chainlink native/USD conversion helpers with staleness checks.
/// @dev Stateless library used by Factory and Claim fee module.
library PriceLib {
    /// @notice Fetches a price and validates freshness.
    /// @param feed Chainlink AggregatorV3 (native/USD).
    /// @param maxAge Max allowed age (seconds).
    /// @return price The latest price (answer).
    /// @return dec   The feed decimals.
    function fetchPrice(address feed, uint32 maxAge)
        internal
        view
        returns (int256 price, uint8 dec)
    {
        AggregatorV3Interface f = AggregatorV3Interface(feed);
        (uint80 rid, int256 p, , uint256 updatedAt, uint80 ansRid) = f.latestRoundData();
        if (p <= 0 || ansRid < rid) revert BadPrice();
        if (block.timestamp - updatedAt > maxAge) revert StalePrice();
        dec = f.decimals();
        return (p, dec);
    }

    /// @notice Converts USD cents to native wei using Chainlink (ceil rounded).
    /// @dev wei = ceil( (usdCents/100) * 10^(18+decimals) / price ).
    /// @param feed Chainlink AggregatorV3 (native/USD).
    /// @param maxAge Max allowed price age.
    /// @param usdCents USD cents amount (0 for disabled).
    /// @return weiAmt Required wei (ceil-rounded).
    function usdCentsToWei(address feed, uint32 maxAge, uint64 usdCents)
        internal
        view
        returns (uint256 weiAmt)
    {
        if (usdCents == 0) return 0;
        (int256 price, uint8 dec) = fetchPrice(feed, maxAge);
        // Prevent unsafe exponentiation for extreme feed decimals
        if (dec > 18) revert InvalidFeedDecimals();
        uint256 num = (uint256(usdCents) * (10 ** (18 + dec))) / 100;
        uint256 den = uint256(uint256(price));
        weiAmt = (num + den - 1) / den; // ceil division
    }
}
