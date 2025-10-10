// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

/// @title Common custom errors for Snag Airdrop Protocol
/// @notice Centralized errors, cheaper than revert strings.

/// ---------------- Common / Factory ----------------
error ZeroAdmin();
error InvalidToken();
error InvalidStakingContract();
error AlreadyDeployed();
error Expired();
error UnexpectedDeployer();
error InvalidSigner();
error ZeroAddress();
error RoleAlreadyGranted();
error RoleNotGranted();

/// ---------------- Price / Fees ----------------
error BadPrice();
error StalePrice();
error InvalidFeedDecimals();
error InsufficientDeploymentFee();
error InsufficientFee();
error FeeTransferFailed();
error RefundFailed();

/// ---------------- Claim flow ----------------
error AirdropNotActive();
error AlreadyClaimed();
error InvalidProof();
error PctSumExceeded();
error PctSumNot100();
error NoStaking();
error LockupTooShort();
error InvalidOptionId();
error InvalidMultiplier();
error InvalidClaimSignature();
error SignatureAlreadyUsed();
error OutOfTokens(uint256 required, uint256 available);

/// ---------------- Roles ----------------
error NotAdmin();
error NotProtocolAdmin();
