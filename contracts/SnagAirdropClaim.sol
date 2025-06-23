// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import {Context}  from '@openzeppelin/contracts/utils/Context.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {MerkleProof} from '@openzeppelin/contracts/utils/cryptography/MerkleProof.sol';
import {IERC20}  from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ILinearStake} from './interfaces/ILinearStake.sol';
import {ISnagAirdropClaim} from './interfaces/ISnagAirdropClaim.sol';
import {EIP712}  from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import {ECDSA}   from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

error OutOfTokens(uint256 required, uint256 available);
error OnlyRouter();
error InvalidSignature();
error PctSumExceeded();
error NoStaking();
error LockupTooShort();
error InvalidOptionId();
error AirdropNotActive();
error AlreadyClaimed();
error InvalidProof();

contract SnagAirdropClaim is Context, Pausable, ISnagAirdropClaim, EIP712 {
    // ───────────── State ───────────────────────────────────────────
    address public immutable router;
    bytes32 public override root;
    IERC20 private _tokenAsset;
    ILinearStake public override stakingAddress;
    uint256 public override multiplier;
    uint256 public totalClaimed;
    uint256 public totalStaked;
    uint256 public totalBonusTokens;
    uint32 public minLockupDuration;
    uint32 public minLockupDurationForMultiplier;
    bool public isActive;
    mapping(address => uint256) public override claimedAmount;

    /// @dev EIP-712 type hash for ClaimRequest
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "ClaimRequest(bytes32 id,address beneficiary,uint256 totalAllocation,uint8 percentageToClaim,uint8 percentageToStake,uint32 lockupPeriod,bytes32 optionId,address router)"
    );

    modifier onlyRouter() {
        if (_msgSender() != router) revert OnlyRouter();
        _;
    }

    // ───────────── Constructor ─────────────────────────────────────
    constructor(
        bytes32 _root,
        address _asset,
        address _staking,
        uint256 _multiplier,
        uint32 _minLockupDuration,
        uint32 _minLockupDurationForMultiplier
    ) EIP712("SnagAirdropClaim", "1") {
        router                         = _msgSender();
        root                           = _root;
        _tokenAsset                    = IERC20(_asset);
        stakingAddress                 = ILinearStake(_staking);
        multiplier                     = _multiplier;
        minLockupDuration              = _minLockupDuration;
        minLockupDurationForMultiplier = _minLockupDurationForMultiplier;
        isActive                       = true;
        _pause();

        if (address(stakingAddress) != address(0)) {
            _tokenAsset.approve(address(stakingAddress), type(uint256).max);
        }
    }

    // ───────────── View Helpers ────────────────────────────────────
    function tokenAsset() external view override returns (address) {
        return address(_tokenAsset);
    }

    function paused() public view override(Pausable, ISnagAirdropClaim) returns (bool) {
        return super.paused();
    }

    function validateClaimOptions(ClaimOptions memory o) public view {
        uint256 sum = o.percentageToClaim + o.percentageToStake;
        if (sum > 100) revert PctSumExceeded();

        if (o.percentageToStake > 0) {
            if (address(stakingAddress) == address(0)) revert NoStaking();
            if (o.lockupPeriod <= minLockupDuration) revert LockupTooShort();
            if (o.optionId == bytes32(0)) revert InvalidOptionId();
        }

        if (o.percentageToClaim < 100) {
            if (o.optionId == bytes32(0)) revert InvalidOptionId();
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
        onlyRouter
        returns (uint256 amountClaimed, uint256 amountStaked)
    {
        _verifySignature(id, beneficiary, totalAllocation, o, signature);
        _verifyAndRecordClaim(beneficiary, totalAllocation, proof, o);

        // calculate amounts
        amountClaimed = (totalAllocation * o.percentageToClaim) / 100;
        amountStaked  = (totalAllocation * o.percentageToStake) / 100;
        totalClaimed += amountClaimed;
        totalStaked  += amountStaked;

        // optional bonus
        uint256 bonus = 0;
        if (multiplier > 0 && o.lockupPeriod >= minLockupDurationForMultiplier) {
            bonus = (amountStaked * multiplier) / 10_000;
            totalBonusTokens += bonus;
        }

        // payout & stake
        if (amountClaimed > 0) {
            uint256 available = _tokenAsset.balanceOf(address(this));
            if (available < amountClaimed) revert OutOfTokens(amountClaimed, available);
            _tokenAsset.transfer(beneficiary, amountClaimed);
        }
        uint256 toStake = amountStaked + bonus;
        if (toStake > 0) {
            uint256 available = _tokenAsset.balanceOf(address(this));
            if (available < toStake) revert OutOfTokens(toStake, available);
            _tokenAsset.transfer(address(stakingAddress), toStake);
            stakingAddress.stakeFor(beneficiary, toStake, o.lockupPeriod);
        }
    }

    /// @dev Verifies the EIP-712 payload and signer
    function _verifySignature(
        bytes32 id,
        address beneficiary,
        uint256 totalAllocation,
        ClaimOptions calldata o,
        bytes calldata signature
    ) private view {
        bytes32 structHash = keccak256(abi.encode(
            CLAIM_TYPEHASH,
            id,
            beneficiary,
            totalAllocation,
            o.percentageToClaim,
            o.percentageToStake,
            o.lockupPeriod,
            o.optionId,
            router
        ));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != beneficiary) revert InvalidSignature();
    }

    /// @dev Checks Merkle proof, airdrop state, and records one‐time claim
    function _verifyAndRecordClaim(
        address beneficiary,
        uint256 totalAllocation,
        bytes32[] calldata proof,
        ClaimOptions calldata o
    ) private {
        if (!isActive) revert AirdropNotActive();
        if (claimedAmount[beneficiary] != 0) revert AlreadyClaimed();
        validateClaimOptions(o);

        bytes32 leaf = keccak256(bytes.concat(
            keccak256(abi.encode(beneficiary, totalAllocation))
        ));
        if (!MerkleProof.verify(proof, root, leaf)) revert InvalidProof();

        uint256 pctSum = uint256(o.percentageToClaim) + o.percentageToStake;
        claimedAmount[beneficiary] = (totalAllocation * pctSum) / 100;
    }

    // ───────────── Admin / Router Only ───────────────────────────
    function setMultiplier(uint256 m) external onlyRouter {
        multiplier = m;
    }

    function endAirdrop(address to) external onlyRouter {
        _tokenAsset.transfer(to, _tokenAsset.balanceOf(address(this)));
        isActive = false;
    }

    function pause()   external  onlyRouter { _pause(); }
    function unpause() external onlyRouter { _unpause(); }
}