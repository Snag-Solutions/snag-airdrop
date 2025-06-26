// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {MerkleProof} from '@openzeppelin/contracts/utils/cryptography/MerkleProof.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ILinearStake} from './interfaces/ILinearStake.sol';
import {ISnagAirdropClaim} from './interfaces/ISnagAirdropClaim.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

/// @title SnagAirdropClaim
/// @author Snag Protocol
/// @notice Per-airdrop claim contract with signed ClaimOptions and optional staking
/// @dev This contract handles the core airdrop functionality including claim verification,
/// token distribution, staking integration, and bonus multiplier calculations.
contract SnagAirdropClaim is
    Context,
    Pausable,
    ReentrancyGuard,
    ISnagAirdropClaim,
    EIP712
{
    using SafeERC20 for IERC20;

    // ───────────── State ───────────────────────────────────────────
    bytes32 public override root;
    mapping(address => uint256) public override claimedAmount;
    uint32 public minLockupDuration;
    uint32 public minLockupDurationForMultiplier;
    bool public isActive;
    IERC20 private _tokenAsset;
    ILinearStake public override stakingAddress;
    uint256 public override multiplier;
    uint256 public maxBonus;
    uint256 public totalClaimed;
    uint256 public totalStaked;
    uint256 public totalBonusTokens;

    address public immutable router;

    /// @dev EIP-712 type hash for ClaimRequest
    bytes32 private constant CLAIM_TYPEHASH =
        keccak256(
            'ClaimRequest(bytes32 id,address beneficiary,uint256 totalAllocation,uint16 percentageToClaim,uint16 percentageToStake,uint32 lockupPeriod,bytes32 optionId)'
        );

    /// @dev Modifier to ensure only the router can call functions
    modifier onlyRouter() {
        if (_msgSender() != router) revert OnlyRouter();
        _;
    }

    // ───────────── Constructor ─────────────────────────────────────
    /// @notice Initialize the airdrop claim contract
    /// @param _root The Merkle root for claim verification
    /// @param _asset The ERC-20 token address to distribute
    /// @param _staking The staking contract address (can be address(0))
    /// @param _maxBonus The maximum bonus amount in basis points
    /// @param _minLockupDuration Minimum lockup duration in seconds
    /// @param _minLockupDurationForMultiplier Minimum lockup duration for bonus multiplier
    /// @param _multiplier Bonus multiplier in basis points
    constructor(
        bytes32 _root,
        address _asset,
        address _staking,
        uint256 _maxBonus,
        uint32 _minLockupDuration,
        uint32 _minLockupDurationForMultiplier,
        uint256 _multiplier
    ) EIP712('SnagAirdropClaim', '1') {
        router = _msgSender();
        root = _root;
        _tokenAsset = IERC20(_asset);
        stakingAddress = ILinearStake(_staking);
        minLockupDuration = _minLockupDuration;
        minLockupDurationForMultiplier = _minLockupDurationForMultiplier;
        multiplier = _multiplier;
        maxBonus = _maxBonus;
        isActive = true;
        _pause();

        if (address(stakingAddress) != address(0)) {
            _tokenAsset.approve(address(stakingAddress), type(uint256).max);
        }
    }

    // ───────────── View Helpers ────────────────────────────────────
    /// @inheritdoc ISnagAirdropClaim
    function tokenAsset() external view override returns (address) {
        return address(_tokenAsset);
    }

    /// @inheritdoc ISnagAirdropClaim
    function paused()
        public
        view
        override(Pausable, ISnagAirdropClaim)
        returns (bool)
    {
        return super.paused();
    }

    /// @inheritdoc ISnagAirdropClaim
    function validateClaimOptions(ClaimOptions memory o) public view {
        if (o.percentageToClaim + o.percentageToStake > 10_000)
            revert PctSumExceeded();
        if (o.optionId == bytes32(0)) revert InvalidOptionId();

        if (o.percentageToStake > 0) {
            if (address(stakingAddress) == address(0)) revert NoStaking();
            if (o.lockupPeriod <= minLockupDuration) revert LockupTooShort();
        }
    }

    // ───────────── Core Claim Logic ────────────────────────────────
    /// @inheritdoc ISnagAirdropClaim
    function claimFor(
        address beneficiary,
        bytes32 id,
        bytes32[] calldata proof,
        uint256 totalAllocation,
        ClaimOptions calldata o,
        bytes calldata signature
    )
        external
        whenNotPaused
        nonReentrant
        onlyRouter
        returns (uint256 amountClaimed, uint256 amountStaked)
    {
        _verifySignature(id, beneficiary, totalAllocation, o, signature);
        _verifyAndRecordClaim(beneficiary, totalAllocation, proof, o);

        // calculate amounts
        amountClaimed = (totalAllocation * o.percentageToClaim) / 10_000;
        amountStaked = (totalAllocation * o.percentageToStake) / 10_000;
        totalClaimed += amountClaimed;
        totalStaked += amountStaked;

        // optional bonus
        uint256 bonus = 0;
        if (
            multiplier > 0 && o.lockupPeriod >= minLockupDurationForMultiplier
        ) {
            bonus = (amountStaked * multiplier) / 10_000;
            // Cap bonus at maxBonus if it exceeds the limit
            if (bonus > maxBonus) {
                bonus = maxBonus;
            }
            totalBonusTokens += bonus;
        }

        // payout & stake
        if (amountClaimed > 0) {
            uint256 available = _tokenAsset.balanceOf(address(this));
            if (available < amountClaimed)
                revert OutOfTokens(amountClaimed, available);
            _tokenAsset.safeTransfer(beneficiary, amountClaimed);
        }
        uint256 toStake = amountStaked + bonus;
        if (toStake > 0) {
            uint256 available = _tokenAsset.balanceOf(address(this));
            if (available < toStake) revert OutOfTokens(toStake, available);
            _tokenAsset.safeTransfer(address(stakingAddress), toStake);
            stakingAddress.stakeFor(beneficiary, toStake, o.lockupPeriod);
        }
    }

    /// @dev Verifies the EIP-712 payload and signer
    /// @param id The airdrop identifier
    /// @param beneficiary The beneficiary address
    /// @param totalAllocation The total allocation amount
    /// @param o The claim options
    /// @param signature The EIP-712 signature
    function _verifySignature(
        bytes32 id,
        address beneficiary,
        uint256 totalAllocation,
        ClaimOptions calldata o,
        bytes calldata signature
    ) private view {
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                id,
                beneficiary,
                totalAllocation,
                o.percentageToClaim,
                o.percentageToStake,
                o.lockupPeriod,
                o.optionId
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != beneficiary) revert InvalidSignature();
    }

    /// @dev Checks Merkle proof, airdrop state, and records one-time claim
    /// @param beneficiary The beneficiary address
    /// @param totalAllocation The total allocation amount
    /// @param proof The Merkle proof
    /// @param o The claim options
    function _verifyAndRecordClaim(
        address beneficiary,
        uint256 totalAllocation,
        bytes32[] calldata proof,
        ClaimOptions calldata o
    ) private {
        if (!isActive) revert AirdropNotActive();
        if (claimedAmount[beneficiary] != 0) revert AlreadyClaimed();
        validateClaimOptions(o);

        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(beneficiary, totalAllocation)))
        );
        if (!MerkleProof.verify(proof, root, leaf)) revert InvalidProof();

        uint256 pctSum = uint256(o.percentageToClaim) +
            uint256(o.percentageToStake);
        claimedAmount[beneficiary] = (totalAllocation * pctSum) / 10_000;
    }

    // ───────────── Admin / Router Only ───────────────────────────
    /// @inheritdoc ISnagAirdropClaim
    function setMultiplier(uint256 m) external onlyRouter {
        uint256 oldMultiplier = multiplier;
        multiplier = m;
        emit MultiplierUpdated(oldMultiplier, m);
    }

    /// @inheritdoc ISnagAirdropClaim
    function endAirdrop(address to) external onlyRouter {
        uint256 amount = _tokenAsset.balanceOf(address(this));
        _tokenAsset.safeTransfer(to, amount);
        isActive = false;
        emit AirdropEnded(to, amount);
    }

    /// @inheritdoc ISnagAirdropClaim
    function pause() external onlyRouter {
        _pause();
    }

    /// @inheritdoc ISnagAirdropClaim
    function unpause() external onlyRouter {
        _unpause();
    }
}
