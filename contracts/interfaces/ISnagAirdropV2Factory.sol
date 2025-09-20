// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

/// @title ISnagAirdropV2Factory
/// @notice Interface for the Snag signed-only airdrop factory.
/// @dev EIP-712 authorizes deployments; concrete implementation should use `@inheritdoc`.
interface ISnagAirdropV2Factory {
    /// @notice Emitted when a new airdrop is created.
    /// @param id Deterministic id = keccak256(abi.encode(deployer, salt)).
    /// @param claimContract Address of the deployed claim contract.
    event AirdropCreated(bytes32 indexed id, address claimContract);

    /// @notice Overflow behavior once the USD-cap is reached.
    enum FeeOverflowMode { Cancel, RouteToPartner, RouteToProtocol }

    /// @notice Airdrop deployment parameters.
    struct CreateParams {
        /// @notice CREATE2 salt contextualized by the deployer EOA.
        bytes32 salt;
        /// @notice Claim admin (partner).
        address admin;
        /// @notice Merkle root for allocations.
        bytes32 root;
        /// @notice ERC20 token address to distribute.
        address token;
        /// @notice Optional staking contract (IBaseStake).
        address staking;
        /// @notice Max bonus tokens per claim (absolute cap).
        uint256 maxBonus;
        /// @notice Min staking lockup (seconds).
        uint32  minLockup;
        /// @notice Lockup required to qualify for multiplier (seconds).
        uint32  minLockupForMultiplier;
        /// @notice Bonus multiplier in bips (0..10_000).
        uint256 multiplier;
    }

    /// @notice Protocol fee configuration per airdrop (immutable post-deploy).
    struct ProtocolFeeConfig {
        /// @notice Flat USD fee for claim-only (0 disables).
        uint64 feeClaimUsdCents;
        /// @notice Flat USD fee when staking is selected (0 disables).
        uint64 feeStakeUsdCents;
        /// @notice Global cap in USD cents (0 = no cap).
        uint64 feeCapUsdCents;

        /// @notice Chainlink native/USD aggregator.
        address priceFeed;
        /// @notice Max accepted price age (seconds).
        uint32  maxPriceAge;

        /// @notice Receiver pre-cap (protocol treasury).
        address protocolTreasury;
        /// @notice Receiver post-cap if Mode = RouteToProtocol.
        address protocolOverflow;
        /// @notice Receiver post-cap if Mode = RouteToPartner (rotatable by partner via claim).
        address partnerOverflow;

        /// @notice Cancel / RouteToPartner / RouteToProtocol.
        FeeOverflowMode overflowMode;

        /// @notice Protocol share of distributed tokens (bips, 0..10_000).
        /// @dev Withdraw gated by Factory's PROTOCOL_ADMIN_ROLE.
        uint16  protocolTokenShareBips;
    }

    /**
     * @notice Signed-only deployment. Deploys a deterministic claim via CREATE2 and initializes it.
     * @param p Airdrop parameters.
     * @param f Protocol fee configuration.
     * @param deploymentFeeUsdCents Optional one-time USD-pegged fee at deployment (0 = none).
     * @param expectedDeployer Externally-owned address expected to submit this tx.
     * @param deadline Signature expiration timestamp (seconds).
     * @param signature EIP-712 signature from a Factory PROTOCOL_SIGNER_ROLE over the full payload.
     * @return claimAddress The deployed airdrop claim contract address.
     */
    function createAirdropSigned(
        CreateParams calldata p,
        ProtocolFeeConfig calldata f,
        uint64 deploymentFeeUsdCents,
        address expectedDeployer,
        uint256 deadline,
        bytes calldata signature
    ) external payable returns (address claimAddress);

    /// @notice Deterministic map: id -> claim address, where `id = keccak256(abi.encode(deployer, salt))`.
    function airdropContracts(bytes32 id) external view returns (address);

    /**
     * @notice Helper: preview deployment fee (wei) for UI/offchain checks.
     * @dev Same math as used on-chain to collect deployment fee. Subject to price movement.
     */
    function previewDeploymentFeeWei(
        ProtocolFeeConfig calldata f,
        uint64 deploymentFeeUsdCents
    ) external view returns (uint256);
}
