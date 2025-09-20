// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {AccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {IERC165} from '@openzeppelin/contracts/utils/introspection/IERC165.sol';
import {ERC165Checker} from '@openzeppelin/contracts/utils/introspection/ERC165Checker.sol';
import {ECDSA} from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

import {ISnagAirdropV2Factory} from './interfaces/ISnagAirdropV2Factory.sol';
import {IBaseStake} from './interfaces/IBaseStake.sol';
import {SnagAirdropV2Claim} from './Claim.sol';
import {SnagFeeModule} from './modules/SnagFeeModule.sol';

import {ZeroAdmin, InvalidToken, InvalidStakingContract, AlreadyDeployed, Expired, UnexpectedDeployer, InvalidSigner, InsufficientDeploymentFee, RefundFailed} from './errors/Errors.sol';

import {PriceLib} from './libs/PriceLib.sol';

/// @title SnagAirdropV2Factory
/// @notice Signed-only factory for deploying Snag airdrop claim contracts with immutable fee configs.
/// @dev Uses AccessControl for protocol admin and signer roles; enforces EIP-712 authorization for deployment.
contract SnagAirdropV2Factory is Context, ISnagAirdropV2Factory, AccessControl {
    struct CreateDigest {
        bytes32 typehash;
        address factory;
        uint256 chainId;
        address expectedDeployer;
        uint256 deadline;
        bytes32 salt;
        address admin;
        bytes32 root;
        address token;
        address staking;
        uint256 maxBonus;
        uint32  minLockup;
        uint32  minLockupForMultiplier;
        uint256 multiplier;
        uint64  feeClaimUsdCents;
        uint64  feeStakeUsdCents;
        uint64  feeCapUsdCents;
        address priceFeed;
        uint32  maxPriceAge;
        address protocolTreasury;
        address protocolOverflow;
        address partnerOverflow;
        uint8   overflowMode;
        uint16  protocolTokenShareBips;
        uint64  deploymentFeeUsdCents;
    }
    /// @notice Protocol admin role (can grant/revoke protocol signers).
    bytes32 public constant PROTOCOL_ADMIN_ROLE =
        keccak256('PROTOCOL_ADMIN_ROLE');
    /// @notice Protocol signer role (authorizes deployments via EIP-712 signatures).
    bytes32 public constant PROTOCOL_SIGNER_ROLE =
        keccak256('PROTOCOL_SIGNER_ROLE');

    /// @inheritdoc ISnagAirdropV2Factory
    mapping(bytes32 => address) public override airdropContracts;

    /// @dev EIP-712 domain separator (contract-specific).
    bytes32 private immutable _DOMAIN_SEPARATOR;

    /// @dev EIP-712 typehash for create payload.
    bytes32 private constant _CREATE_TYPEHASH =
        keccak256(
            'CreateAirdrop(address factory,uint256 chainId,address expectedDeployer,uint256 deadline,bytes32 salt,address admin,bytes32 root,address token,address staking,uint256 maxBonus,uint32 minLockup,uint32 minLockupForMultiplier,uint256 multiplier,uint64 feeClaimUsdCents,uint64 feeStakeUsdCents,uint64 feeCapUsdCents,address priceFeed,uint32 maxPriceAge,address protocolTreasury,address protocolOverflow,address partnerOverflow,uint8 overflowMode,uint16 protocolTokenShareBips,uint64 deploymentFeeUsdCents)'
        );

    /**
     * @notice Factory constructor.
     * @param protocolAdmin Initial protocol admin who can manage roles.
     */
    constructor(address protocolAdmin) {
        _grantRole(DEFAULT_ADMIN_ROLE, protocolAdmin);
        _grantRole(PROTOCOL_ADMIN_ROLE, protocolAdmin);

        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    'EIP712Domain(string name,string version,address verifyingContract)'
                ),
                keccak256(bytes('SnagAirdropV2Factory')),
                keccak256(bytes('1')),
                address(this)
            )
        );
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
        CreateDigest memory d;
        d.typehash = _CREATE_TYPEHASH;
        d.factory = address(this);
        d.chainId = block.chainid;
        d.expectedDeployer = expectedDeployer;
        d.deadline = deadline;
        d.salt = p.salt;
        d.admin = p.admin;
        d.root = p.root;
        d.token = p.token;
        d.staking = p.staking;
        d.maxBonus = p.maxBonus;
        d.minLockup = p.minLockup;
        d.minLockupForMultiplier = p.minLockupForMultiplier;
        d.multiplier = p.multiplier;
        d.feeClaimUsdCents = f.feeClaimUsdCents;
        d.feeStakeUsdCents = f.feeStakeUsdCents;
        d.feeCapUsdCents = f.feeCapUsdCents;
        d.priceFeed = f.priceFeed;
        d.maxPriceAge = f.maxPriceAge;
        d.protocolTreasury = f.protocolTreasury;
        d.protocolOverflow = f.protocolOverflow;
        d.partnerOverflow = f.partnerOverflow;
        d.overflowMode = uint8(f.overflowMode);
        d.protocolTokenShareBips = f.protocolTokenShareBips;
        d.deploymentFeeUsdCents = deploymentFeeUsdCents;

        bytes32 structHash = keccak256(abi.encode(d));
        return keccak256(abi.encodePacked('\x19\x01', _DOMAIN_SEPARATOR, structHash));
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
        assembly {
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
        cfg.overflowMode = SnagFeeModule.FeeOverflowMode(uint8(f.overflowMode));
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
