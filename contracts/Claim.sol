// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {MerkleProof} from '@openzeppelin/contracts/utils/cryptography/MerkleProof.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ILinearStake} from './interfaces/ILinearStake.sol';
import {ISnagAirdropV2Claim} from './interfaces/ISnagAirdropV2Claim.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

import "./errors/Errors.sol";

import {SnagFeeModule} from "./modules/SnagFeeModule.sol";

/// @title SnagAirdropV2Claim
/// @notice Airdrop claim contract with optional staking, USD-pegged fees, overflow routing, and protocol token share.
/// @dev Fee mechanics are isolated in SnagFeeModule; this contract focuses on claims + admin controls.
contract SnagAirdropV2Claim is
    Context,
    Pausable,
    ReentrancyGuard,
    ISnagAirdropV2Claim,
    EIP712,
    SnagFeeModule
{
    using SafeERC20 for IERC20;

    /// @notice Initialization bundle for core airdrop params.
    struct InitParams {
        address admin;
        bytes32 root;
        address asset;
        address staking;
        uint256 maxBonus;
        uint32  minLockupDuration;
        uint32  minLockupDurationForMultiplier;
        uint256 multiplier;
    }

    /// @notice Initialization bundle for fee module + protocol token share.
    /// @dev Shared via FeeConfigTypes.InitFeeConfig

    /// @notice Address of the factory (deployer) used for protocol role checks.
    /// @dev Immutable to prevent spoofing; set from _msgSender() in constructor.
    address public immutable factory;

    /// @notice Role name used on the Factory for protocol admin checks.
    /// @dev Only addresses with this role on the Factory can withdraw protocol token share.
    bytes32 public constant PROTOCOL_ADMIN_ROLE = keccak256("PROTOCOL_ADMIN_ROLE");

    // ---- Public state (auto-getters) ----
    bytes32  public root;                                   /// Merkle root for allocations.
    mapping(address => uint256) public claimedAmount;        /// Amount already consumed by user (claim+stake sum).
    uint32   public minLockupDuration;                       /// Min lockup to allow staking.
    uint32   public minLockupDurationForMultiplier;          /// Lockup required to receive multiplier.
    bool     public isActive;                                /// True while airdrop is active.
    IERC20   public tokenAsset;                              /// ERC-20 token distributed (getter returns address).
    ILinearStake public stakingAddress;                      /// Optional staking contract (getter returns address).
    uint256  public multiplier;                              /// Bonus multiplier (bips).
    uint256  public maxBonus;                                /// Max bonus tokens (absolute).
    uint256  public totalClaimed;                            /// Total immediately claimed (sum).
    uint256  public totalStaked;                             /// Total staked (sum).
    uint256  public totalBonusTokens;                        /// Total bonus minted/allocated.


    /// @notice Contract admin (partner).
    address private _admin;

    /// @notice Initialization guard.
    bool private _initialized;

    /// @notice Replay protection: per-beneficiary used nonces.
    mapping(address => mapping(bytes32 => bool)) private _nonceUsed;

    /// @notice EIP-712 ClaimRequest typehash.
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256(
            'ClaimRequest(address claimAddress,address beneficiary,uint256 totalAllocation,uint16 percentageToClaim,uint16 percentageToStake,uint32 lockupPeriod,bytes32 optionId,uint256 multiplier,bytes32 nonce)'
        );

    /// @notice Restricts function to the claim admin.
    modifier onlyAdmin() {
        if (_msgSender() != _admin) revert NotAdmin();
        _;
    }

    /// @notice Restricts function to the factory (deployer) only.
    modifier onlyFactory() {
        if (_msgSender() != factory) revert UnexpectedDeployer();
        _;
    }

    /// @notice Constructs the claim and pins `factory` = deploying address (the Factory).
    constructor() EIP712('SnagAirdropClaim', '1') {
        factory = _msgSender();
    }

    // ---------------- Initialization ----------------

    /**
     * @notice Initialize the claim contract (callable once by the factory).
     * @dev Sets airdrop params and fee config; approves staking if provided.
     *
     * @param p Core airdrop parameters.
     * @param cfg Fee module + token-share configuration bundle.
     */
    function initialize(
        InitParams calldata p,
        SnagFeeModule.InitFeeConfig calldata cfg
    ) external onlyFactory {
        if (_initialized) revert AlreadyInitialized();
        if (p.admin == address(0)) revert NotAdmin();

        _admin  = p.admin;
        root    = p.root;
        tokenAsset = IERC20(p.asset);
        stakingAddress = ILinearStake(p.staking);
        minLockupDuration = p.minLockupDuration;
        minLockupDurationForMultiplier = p.minLockupDurationForMultiplier;
        multiplier = p.multiplier;
        maxBonus = p.maxBonus;
        isActive = true;
        _initialized = true;

        _pause(); // Start paused; partner can unpause after funding.

        if (address(stakingAddress) != address(0)) {
            tokenAsset.approve(address(stakingAddress), type(uint256).max);
        }

        __snagFee_init(cfg);

        emit AirdropInitialized(
            _admin,
            root,
            address(tokenAsset),
            address(stakingAddress),
            maxBonus,
            minLockupDuration,
            minLockupDurationForMultiplier,
            multiplier,
            cfg.priceFeed,
            cfg.maxPriceAge,
            protocolTreasury,
            protocolOverflow,
            partnerOverflow,
            cfg.feeClaimUsdCents,
            cfg.feeStakeUsdCents,
            cfg.feeCapUsdCents,
            cfg.overflowMode,
            cfg.protocolTokenShareBips
        );
    }

    // ---------------- Partner & Protocol controls ----------------

    /**
     * @notice Update the partner overflow address used post-cap when `overflowMode = RouteToPartner`.
     * @dev Callable by claim admin at any time.
     * @param next The new partner overflow destination.
     */
    function updatePartnerOverflow(address next) external onlyAdmin {
        _updatePartnerOverflow(next);
    }

    /**
     * @notice Withdraw protocol-accrued token share (protocol admin only).
     * @dev Only addresses that have PROTOCOL_ADMIN_ROLE on the Factory may withdraw.
     * @param to Recipient of the protocol-accrued tokens.
     * @param amount Amount to withdraw (must be ≤ protocolAccruedTokens).
     */
    function withdrawProtocolAccrued(address to, uint256 amount) external nonReentrant {
        if (!IAccessControl(factory).hasRole(PROTOCOL_ADMIN_ROLE, _msgSender())) {
            revert NotProtocolAdmin();
        }
        if (to == address(0)) revert NotProtocolAdmin(); // zero-address guard via role error reuse
        if (amount > protocolAccruedTokens) revert OutOfTokens(amount, protocolAccruedTokens);

        _markProtocolWithdraw(to, amount);
        tokenAsset.safeTransfer(to, amount);
    }

    // ---------------- Views ----------------

    /// @inheritdoc ISnagAirdropV2Claim
    function validateClaimOptions(ClaimOptions calldata o) external view returns (uint256 requiredWei) {
        uint256 pctSum = uint256(o.percentageToClaim) + uint256(o.percentageToStake);
        if (pctSum > 10_000) revert PctSumExceeded();
        if (pctSum < 10_000) revert PctSumNot100();
        if (o.optionId == bytes32(0)) revert InvalidOptionId();
        if (o.multiplier != multiplier) revert InvalidMultiplier();
        if (o.percentageToStake > 0) {
            if (address(stakingAddress) == address(0)) revert NoStaking();
            if (o.lockupPeriod < minLockupDuration) revert LockupTooShort();
            if (multiplier > 0 && o.lockupPeriod < minLockupDurationForMultiplier) revert LockupTooShort();
        }
        bool stakeSelected = (o.percentageToStake > 0);
        return requiredFeeWei(stakeSelected);
    }

    // ---------------- Claim flow ----------------

    /// @inheritdoc ISnagAirdropV2Claim
    function claimFor(
        address beneficiary,
        bytes32[] calldata proof,
        uint256 totalAllocation,
        ClaimOptions calldata o,
        bytes32 nonce,
        bytes calldata signature
    )
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 amountClaimed, uint256 amountStaked)
    {
        _verifySignature(beneficiary, totalAllocation, o, nonce, signature);
        _verifyAndRecordClaim(beneficiary, totalAllocation, proof, o);
        if (_nonceUsed[beneficiary][nonce]) revert SignatureAlreadyUsed();
        _nonceUsed[beneficiary][nonce] = true;

        // 1) Collect user fee (stake path beats claim path)
        bool stakeSelected = (o.percentageToStake > 0);
        (address feeReceiver, uint256 feeWeiPaid) = _collectUserFee(stakeSelected);

        // 2) Compute amounts
        amountClaimed = (totalAllocation * o.percentageToClaim) / 10_000;
        amountStaked  = (totalAllocation * o.percentageToStake) / 10_000;

        totalClaimed += amountClaimed;
        totalStaked  += amountStaked;

        uint256 bonus = 0;
        if (multiplier > 0 && amountStaked > 0 && o.lockupPeriod >= minLockupDurationForMultiplier) {
            bonus = (amountStaked * multiplier) / 10_000;
            if (bonus > maxBonus) bonus = maxBonus;
            totalBonusTokens += bonus;
        }

        // 3) Protocol token share (does NOT reduce user amounts)
        uint256 distributed  = amountClaimed + amountStaked + bonus;
        uint256 protocolTake = _protocolShare(distributed);

        // 4) Ensure sufficient balance for all transfers
        uint256 need = amountClaimed + amountStaked + bonus + protocolTake;
        uint256 bal  = tokenAsset.balanceOf(address(this));
        if (bal < need) revert OutOfTokens(need, bal);

        if (protocolTake > 0) {
            protocolAccruedTokens += protocolTake;
        }

        _deliver(beneficiary, amountClaimed, amountStaked, bonus, o.lockupPeriod);

        uint64 usdFee = stakeSelected ? feeStakeUsdCents : feeClaimUsdCents;
        emit Claimed(
            beneficiary,
            amountClaimed,
            amountStaked,
            bonus,
            protocolTake,
            o.lockupPeriod,
            feeReceiver,
            feeWeiPaid,
            usdFee,
            overflowMode,
            stakeSelected
        );
    }

    /// @dev Computes the EIP-712 digest for a ClaimRequest.
    function _computeClaimDigest(
        address beneficiary,
        uint256 totalAllocation,
        ClaimOptions calldata o,
        bytes32 nonce
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                address(this),
                beneficiary,
                totalAllocation,
                o.percentageToClaim,
                o.percentageToStake,
                o.lockupPeriod,
                o.optionId,
                o.multiplier,
                nonce
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /// @dev Internal: perform token transfers and optional staking.
    function _deliver(
        address beneficiary,
        uint256 amountClaimed,
        uint256 amountStaked,
        uint256 bonus,
        uint32 lockup
    ) private {
        if (amountClaimed > 0) {
            tokenAsset.safeTransfer(beneficiary, amountClaimed);
        }
        uint256 toStake = amountStaked + bonus;
        if (toStake > 0) {
            // Do not transfer tokens directly; staking contract will pull via allowance
            stakingAddress.stakeFor(beneficiary, toStake, lockup);
        }
    }

    // ---------------- Admin ops ----------------

    /// @inheritdoc ISnagAirdropV2Claim
    function setMultiplier(uint256 newMultiplier) external onlyAdmin {
        uint256 old = multiplier;
        multiplier = newMultiplier;
        emit MultiplierUpdated(old, newMultiplier);
    }

    /// @inheritdoc ISnagAirdropV2Claim
    function endAirdrop(address to) external onlyAdmin {
        uint256 bal = tokenAsset.balanceOf(address(this));
        uint256 accrued = protocolAccruedTokens;
        // Sweep the non-accrued user tokens to the provided recipient.
        uint256 amount = bal > accrued ? (bal - accrued) : 0;
        if (amount > 0) tokenAsset.safeTransfer(to, amount);
        isActive = false;
        emit AirdropEnded(to, amount);
    }

    /// @inheritdoc ISnagAirdropV2Claim
    function pause() external onlyAdmin { _pause(); }

    /// @inheritdoc ISnagAirdropV2Claim
    function unpause() external onlyAdmin { _unpause(); }

    /// @inheritdoc ISnagAirdropV2Claim
    function transferOwnership(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address previousAdmin = _admin;
        _admin = newAdmin;
        emit AirdropOwnershipTransferred(previousAdmin, newAdmin);
    }

    // ---------------- Internals ----------------

    /// @dev Verifies EIP-712 signature; signer must be beneficiary.
    function _verifySignature(
        address beneficiary,
        uint256 totalAllocation,
        ClaimOptions calldata o,
        bytes32 nonce,
        bytes calldata signature
    ) private view {
        bytes32 digest = _computeClaimDigest(beneficiary, totalAllocation, o, nonce);
        address signer = ECDSA.recover(digest, signature);
        if (signer != beneficiary) revert InvalidClaimSignature();
    }

    /// @inheritdoc ISnagAirdropV2Claim
    function cancelNonce(bytes32 nonce) external {
        _nonceUsed[_msgSender()][nonce] = true;
    }

    /// @dev Validates Merkle proof and records consumption.
    function _verifyAndRecordClaim(
        address beneficiary,
        uint256 totalAllocation,
        bytes32[] calldata proof,
        ClaimOptions calldata o
    ) private {
        if (!isActive) revert AirdropNotActive();
        if (claimedAmount[beneficiary] != 0) revert AlreadyClaimed();

        // mirror of validateClaimOptions
        uint256 pctSum = uint256(o.percentageToClaim) + uint256(o.percentageToStake);
        if (pctSum > 10_000) revert PctSumExceeded();
        if (pctSum < 10_000) revert PctSumNot100();
        if (o.optionId == bytes32(0)) revert InvalidOptionId();
        if (o.multiplier != multiplier) revert InvalidMultiplier();
        if (o.percentageToStake > 0) {
            if (address(stakingAddress) == address(0)) revert NoStaking();
            if (o.lockupPeriod < minLockupDuration) revert LockupTooShort();
            if (multiplier > 0 && o.lockupPeriod < minLockupDurationForMultiplier) revert LockupTooShort();
        }

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(beneficiary, totalAllocation))));
        if (!MerkleProof.verify(proof, root, leaf)) revert InvalidProof();

        claimedAmount[beneficiary] = (totalAllocation * pctSum) / 10_000;
    }
}
