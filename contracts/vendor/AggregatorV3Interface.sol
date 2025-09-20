// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title AggregatorV3Interface
/// @notice Minimal Chainlink AggregatorV3 interface for native/USD feeds.
/// @dev Used by PriceLib to fetch price and freshness.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}