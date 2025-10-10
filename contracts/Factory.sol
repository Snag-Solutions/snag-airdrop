// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {AccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {IERC165} from '@openzeppelin/contracts/utils/introspection/IERC165.sol';
import {ERC165Checker} from '@openzeppelin/contracts/utils/introspection/ERC165Checker.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';
import {EIP712} from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';

import {ISnagAirdropV2Factory} from './interfaces/ISnagAirdropV2Factory.sol';
import {IBaseStake} from './interfaces/IBaseStake.sol';
import {SnagAirdropV2Claim} from './Claim.sol';
import {SnagFeeModule} from './modules/SnagFeeModule.sol';

import {ZeroAdmin, InvalidToken, InvalidStakingContract, AlreadyDeployed, Expired, UnexpectedDeployer, InvalidSigner, InsufficientDeploymentFee, RefundFailed} from './errors/Errors.sol';

import {PriceLib} from './libs/PriceLib.sol';

/// @title SnagAirdropV2Factory
/// @notice Signed-only factory for deploying Snag airdrop claim contracts with immutable fee configs.
/// @dev Uses AccessControl for protocol admin and signer roles; enforces EIP-712 authorization for deployment.
contract SnagAirdropV2Factory is Context, ISnagAirdropV2Factory, AccessControl, EIP712 {
    /// @notice Protocol admin role (can grant/revoke protocol signers).
    bytes32 public constant PROTOCOL_ADMIN_ROLE =
        keccak256('PROTOCOL_ADMIN_ROLE');
    /// @notice Protocol signer role (authorizes deployments via EIP-712 signatures).
    bytes32 public constant PROTOCOL_SIGNER_ROLE =
        keccak256('PROTOCOL_SIGNER_ROLE');

    /// @inheritdoc ISnagAirdropV2Factory
    mapping(bytes32 => address) public override airdropContracts;

    /// @dev EIP-712 typehash for create payload.
    bytes32 private constant _CREATE_TYPEHASH =
        keccak256(
            'CreateAirdrop(address factory,address expectedDeployer,uint256 deadline,bytes32 salt,address admin,bytes32 root,address token,address staking,uint256 maxBonus,uint32 minLockup,uint32 minLockupForMultiplier,uint256 multiplier,uint64 feeClaimUsdCents,uint64 feeStakeUsdCents,uint64 feeCapUsdCents,address priceFeed,uint32 maxPriceAge,address protocolTreasury,address protocolOverflow,address partnerOverflow,uint8 overflowMode,uint16 protocolTokenShareBips,uint64 deploymentFeeUsdCents)'
        );

    /**
     * @notice Factory constructor.
     * @param protocolAdmin Initial protocol admin who can manage roles.
     */
    constructor(address protocolAdmin) EIP712('SnagAirdropV2Factory', '1') {
        _grantRole(DEFAULT_ADMIN_ROLE, protocolAdmin);
        _grantRole(PROTOCOL_ADMIN_ROLE, protocolAdmin);
    }

    // ---------------- Role management ----------------

    /// @notice Grant protocol signer role (admin only).
    function grantProtocolSigner(
        address signer
    ) external onlyRole(PROTOCOL_ADMIN_ROLE) {
        _grantRole(PROTOCOL_SIGNER_ROLE, signer);
    }

    /// @notice Revoke protocol signer role (admin only).
    function revokeProtocolSigner(
        address signer
    ) external onlyRole(PROTOCOL_ADMIN_ROLE) {
        _revokeRole(PROTOCOL_SIGNER_ROLE, signer);
    }

    // ---------------- Deployment ----------------

    /// @inheritdoc ISnagAirdropV2Factory
    function createAirdropSigned(
        CreateParams calldata p,
        ProtocolFeeConfig calldata f,
        uint64 deploymentFeeUsdCents,
        address expectedDeployer,
        uint256 deadline,
        bytes calldata signature
    ) external payable override returns (address claimAddress) {
        if (block.timestamp > deadline) revert Expired();
        if (_msgSender() != expectedDeployer) revert UnexpectedDeployer();

        // Verify signer over the full payload (includes deployment fee cents).
        bytes32 digest = _computeCreateDigest(p, f, expectedDeployer, deadline, deploymentFeeUsdCents);
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(PROTOCOL_SIGNER_ROLE, signer)) revert InvalidSigner();

        // Input sanity checks
        _verifyInputs(p);

        // Collect optional deployment fee (USD-pegged, paid in native)
        _collectDeploymentFee(f, deploymentFeeUsdCents);

        // Deterministic id by deployer + salt
        bytes32 id = keccak256(abi.encodePacked(_msgSender(), p.salt));
        if (airdropContracts[id] != address(0)) revert AlreadyDeployed();

        // CREATE2 deploy + initialize
        claimAddress = _deployAndInit(id, p, f);

        airdropContracts[id] = claimAddress;
        emit AirdropCreated(id, claimAddress);
    }

    /// @dev Builds EIP-712 digest for CreateAirdrop.
    function _computeCreateDigest(
        CreateParams calldata p,
        ProtocolFeeConfig calldata f,
        address expectedDeployer,
        uint256 deadline,
        uint64 deploymentFeeUsdCents
    ) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                _CREATE_TYPEHASH,
                address(this),
                expectedDeployer,
                deadline,
                p.salt,
                p.admin,
                p.root,
                p.token,
                p.staking,
                p.maxBonus,
                p.minLockup,
                p.minLockupForMultiplier,
                p.multiplier,
                f.feeClaimUsdCents,
                f.feeStakeUsdCents,
                f.feeCapUsdCents,
                f.priceFeed,
                f.maxPriceAge,
                f.protocolTreasury,
                f.protocolOverflow,
                f.partnerOverflow,
                uint8(f.overflowMode),
                f.protocolTokenShareBips,
                deploymentFeeUsdCents
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /// @inheritdoc ISnagAirdropV2Factory
    function previewDeploymentFeeWei(
        ProtocolFeeConfig calldata f,
        uint64 deploymentFeeUsdCents
    ) external view override returns (uint256) {
        if (deploymentFeeUsdCents == 0) return 0;
        return
            PriceLib.usdCentsToWei(
                f.priceFeed,
                f.maxPriceAge,
                deploymentFeeUsdCents
            );
    }

    // ---------------- Internals ----------------

    /// @dev Basic sanity checks on airdrop parameters.
    function _verifyInputs(CreateParams calldata p) internal view {
        if (p.admin == address(0)) revert ZeroAdmin();
        if (p.token == address(0)) revert InvalidToken();
        if (p.staking != address(0)) {
            if (!ERC165Checker.supportsInterface(p.staking, type(IBaseStake).interfaceId)) {
                revert InvalidStakingContract();
            }
        }
    }

    /// @dev Collects a one-time deployment fee (if configured) and refunds dust.
    function _collectDeploymentFee(
        ISnagAirdropV2Factory.ProtocolFeeConfig calldata f,
        uint64 deploymentFeeUsdCents
    ) internal {
        if (deploymentFeeUsdCents == 0) {
            if (msg.value > 0) {
                (bool r, ) = payable(_msgSender()).call{value: msg.value}('');
                if (!r) revert RefundFailed();
            }
            return;
        }
        uint256 needWei = PriceLib.usdCentsToWei(
            f.priceFeed,
            f.maxPriceAge,
            deploymentFeeUsdCents
        );
        if (msg.value < needWei) revert InsufficientDeploymentFee();
        unchecked {
            (bool ok, ) = payable(f.protocolTreasury).call{value: needWei}('');
            if (!ok) revert RefundFailed();
            uint256 refund = msg.value - needWei;
            if (refund > 0) {
                (bool r2, ) = payable(_msgSender()).call{value: refund}('');
                if (!r2) revert RefundFailed();
            }
        }
    }
    /// @dev Deploys the claim via CREATE2 and initializes it.
    function _deployAndInit(
        bytes32 id,
        CreateParams calldata p,
        ProtocolFeeConfig calldata f
    ) private returns (address claimAddress) {
        bytes memory bytecode = type(SnagAirdropV2Claim).creationCode;
        assembly ("memory-safe") {
            claimAddress := create2(0, add(bytecode, 32), mload(bytecode), id)
            if iszero(claimAddress) {
                revert(0, 0)
            }
        }
        SnagAirdropV2Claim.InitFeeConfig memory cfg;
        cfg.priceFeed = f.priceFeed;
        cfg.maxPriceAge = f.maxPriceAge;
        cfg.protocolTreasury = f.protocolTreasury;
        cfg.protocolOverflow = f.protocolOverflow;
        cfg.partnerOverflow = f.partnerOverflow;
        cfg.feeClaimUsdCents = f.feeClaimUsdCents;
        cfg.feeStakeUsdCents = f.feeStakeUsdCents;
        cfg.feeCapUsdCents = f.feeCapUsdCents;
        cfg.overflowMode = f.overflowMode;
        cfg.protocolTokenShareBips = f.protocolTokenShareBips;

        SnagAirdropV2Claim.InitParams memory ip;
        ip.admin = p.admin;
        ip.root = p.root;
        ip.asset = p.token;
        ip.staking = p.staking;
        ip.maxBonus = p.maxBonus;
        ip.minLockupDuration = p.minLockup;
        ip.minLockupDurationForMultiplier = p.minLockupForMultiplier;
        ip.multiplier = p.multiplier;

        SnagAirdropV2Claim(claimAddress).initialize(ip, cfg);
    }
}
