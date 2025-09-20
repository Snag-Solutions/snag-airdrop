// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AggregatorV3Interface} from "../vendor/AggregatorV3Interface.sol";

/// @title MockAggregatorV3
/// @notice Minimal, flexible mock for Chainlink AggregatorV3 price feeds (native/USD).
/// @dev Default decimals = 8 (typical for Chainlink USD feeds). You can change it in the constructor.
contract MockAggregatorV3 is AggregatorV3Interface {
    uint8 private _decimals;
    uint80 private _roundId;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _answeredInRound;

    event AnswerUpdated(int256 indexed current, uint256 indexed updatedAt, uint80 indexed roundId);

    /// @param decimals_ Feed decimals (e.g., 8 for USD feeds).
    /// @param initialAnswer Initial price (e.g., 3000e8 for $3,000 if decimals=8).
    constructor(uint8 decimals_, int256 initialAnswer) {
        _decimals = decimals_;
        _setRound(block.timestamp, initialAnswer, 1);
    }

    // -------- AggregatorV3Interface --------

    function decimals() external view override returns (uint8) {
        return _decimals;
    }

    function latestRoundData()
        external
        view
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }

    // -------- Test helpers --------

    /// @notice Set a new price; timestamps set to now; roundId increments by 1.
    /// @dev Use values ≤ 0 to simulate BadPrice() in your library.
    function setAnswer(int256 newAnswer) external {
        _setRound(block.timestamp, newAnswer, _roundId + 1);
    }

    /// @notice Set explicit answer and updatedAt (to simulate stale or fresh).
    /// @param newAnswer The price (e.g., 2500e8).
    /// @param newUpdatedAt Epoch seconds (set in the past to simulate staleness).
    function setAnswerWithTimestamp(int256 newAnswer, uint256 newUpdatedAt) external {
        _roundId += 1;
        _answer = newAnswer;
        _startedAt = newUpdatedAt;
        _updatedAt = newUpdatedAt;
        _answeredInRound = _roundId;
        emit AnswerUpdated(newAnswer, newUpdatedAt, _roundId);
    }

    /// @notice Force the feed to appear stale without changing the answer.
    /// @param newUpdatedAt Epoch seconds to report as the last update time.
    function setStale(uint256 newUpdatedAt) external {
        _updatedAt = newUpdatedAt;
        _startedAt = newUpdatedAt;
        emit AnswerUpdated(_answer, newUpdatedAt, _roundId);
    }

    /// @notice Manually set decimals if you need to test decimal mismatches.
    function setDecimals(uint8 newDecimals) external {
        _decimals = newDecimals;
    }

    /// @notice Get current stored values (test convenience).
    function current()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 updatedAt, uint8 decimalsValue)
    {
        return (_roundId, _answer, _updatedAt, _decimals);
    }

    // -------- Internal --------

    function _setRound(uint256 ts, int256 ans, uint80 newRoundId) internal {
        _roundId = newRoundId;
        _answer = ans;
        _startedAt = ts;
        _updatedAt = ts;
        _answeredInRound = newRoundId;
        emit AnswerUpdated(ans, ts, newRoundId);
    }
}

