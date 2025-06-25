// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {LinearStake} from './LinearStake.sol';
import {SnagAirdropClaim} from './SnagAirdropClaim.sol';
import {ISnagAirdropClaim} from './interfaces/ISnagAirdropClaim.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {Context} from '@openzeppelin/contracts/utils/Context.sol';
import {IBaseStake} from './interfaces/IBaseStake.sol';
import {IERC165} from '@openzeppelin/contracts/utils/introspection/IERC165.sol';
import {ISnagAirdropRouter} from './interfaces/ISnagAirdropRouter.sol';

/// @title SnagAirdropRouter
/// @author Snag Protocol
/// @notice Central router and factory for deploying and managing airdrops
/// @dev This contract serves as the main entry point for creating new airdrops
/// and provides administrative functions for managing existing ones.
contract SnagAirdropRouter is Context, ISnagAirdropRouter {
    /// @dev airdropId → claim contract
    mapping(bytes32 => address) public claimContractById;
    /// @dev airdropId → admin address
    mapping(bytes32 => address) public airdropAdmin;

    /// @inheritdoc ISnagAirdropRouter
    function deployClaimContract(
        bytes32 id,
        bytes32 root,
        uint256 multiplier,
        address assetAddress,
        address overrideStakingAddress,
        address admin,
        bool withStaking,
        uint32 minLockupDuration,
        uint32 minLockupDurationForMultiplier
    ) external returns (address) {
        if (claimContractById[id] != address(0)) revert IdExists();
        if (admin == address(0)) revert ZeroAdmin();

        // decide staking address
        address stakingAddr;
        if (withStaking) {
            if (overrideStakingAddress != address(0)) {
                if (
                    !IERC165(overrideStakingAddress).supportsInterface(
                        type(IBaseStake).interfaceId
                    )
                ) revert InvalidStakingAddress();
                stakingAddr = overrideStakingAddress;
            } else {
                stakingAddr = address(new LinearStake(assetAddress));
            }
        }
        SnagAirdropClaim claimC = new SnagAirdropClaim(
            root,
            assetAddress,
            stakingAddr,
            minLockupDuration,
            minLockupDurationForMultiplier,
            multiplier
        );

        claimContractById[id] = address(claimC);
        airdropAdmin[id] = admin;

        emit ClaimContractDeployed(
            id,
            root,
            address(claimC),
            stakingAddr,
            admin
        );

        return address(claimC);
    }

    /// @inheritdoc ISnagAirdropRouter
    function claim(
        bytes32 id,
        address beneficiary,
        bytes32[] calldata proof,
        uint256 totalAllocation,
        ISnagAirdropClaim.ClaimOptions calldata o,
        bytes calldata signature
    ) external {
        address c = claimContractById[id];
        if (c == address(0)) revert InvalidId();

        (uint256 claimedAmt, uint256 stakedAmt) = SnagAirdropClaim(c).claimFor(
            beneficiary,
            id,
            proof,
            totalAllocation,
            o,
            signature
        );

        emit Claimed(
            id,
            beneficiary,
            claimedAmt,
            stakedAmt,
            o.percentageToClaim,
            o.percentageToStake,
            o.lockupPeriod,
            SnagAirdropClaim(c).multiplier()
        );
    }

    /// @inheritdoc ISnagAirdropRouter
    function getStakingAddress(bytes32 id) external view returns (address) {
        address c = claimContractById[id];
        if (c == address(0)) revert InvalidId();
        return address(SnagAirdropClaim(c).stakingAddress());
    }

    /// @inheritdoc ISnagAirdropRouter
    function getClaimData(
        bytes32 id,
        address account
    ) external view returns (ClaimData memory data) {
        address c = claimContractById[id];
        if (c == address(0)) revert InvalidId();

        SnagAirdropClaim claimContract = SnagAirdropClaim(c);
        data.totalClaimed = claimContract.totalClaimed();
        data.totalStaked = claimContract.totalStaked();
        data.totalBonusTokens = claimContract.totalBonusTokens();
        data.minLockupDuration = claimContract.minLockupDuration();
        data.minLockupDurationForMultiplier = claimContract
            .minLockupDurationForMultiplier();
        data.multiplier = claimContract.multiplier();
        data.isActive = claimContract.isActive();
        data.isPaused = claimContract.paused();
        data.tokenAsset = address(claimContract.tokenAsset());
        data.stakingAddress = address(claimContract.stakingAddress());
        data.admin = airdropAdmin[id];

        if (account != address(0)) {
            data.claimedByUser = claimContract.claimedAmount(account);
        }
    }

    /// @inheritdoc ISnagAirdropRouter
    function getStakingData(
        bytes32 id,
        address account
    )
        external
        view
        returns (
            uint256[] memory stakeIds,
            uint256[] memory claimableAmounts,
            uint256 totalClaimable
        )
    {
        address c = claimContractById[id];
        if (c == address(0)) revert InvalidId();

        address stakingAddr = address(SnagAirdropClaim(c).stakingAddress());
        if (stakingAddr != address(0)) {
            IBaseStake stakingContract = IBaseStake(stakingAddr);
            (stakeIds, claimableAmounts) = stakingContract.claimable(
                0,
                account
            );
            for (uint256 i = 0; i < claimableAmounts.length; i++) {
                totalClaimable += claimableAmounts[i];
            }
        } else {
            stakeIds = new uint256[](0);
            claimableAmounts = new uint256[](0);
        }
    }

    //──────── Admin wrappers ────────────────────────────────────

    /// @dev Modifier to ensure only the airdrop admin can call functions
    /// @param id The airdrop identifier
    modifier onlyAirdropAdmin(bytes32 id) {
        if (claimContractById[id] == address(0)) revert InvalidId();
        if (_msgSender() != airdropAdmin[id]) revert NotAirdropAdmin();
        _;
    }

    /// @inheritdoc ISnagAirdropRouter
    function setMultiplier(
        bytes32 id,
        uint256 m
    ) external onlyAirdropAdmin(id) {
        SnagAirdropClaim(claimContractById[id]).setMultiplier(m);
    }

    /// @inheritdoc ISnagAirdropRouter
    function endAirdrop(bytes32 id, address to) external onlyAirdropAdmin(id) {
        SnagAirdropClaim(claimContractById[id]).endAirdrop(to);
    }

    /// @inheritdoc ISnagAirdropRouter
    function pause(bytes32 id) external onlyAirdropAdmin(id) {
        SnagAirdropClaim(claimContractById[id]).pause();
    }

    /// @inheritdoc ISnagAirdropRouter
    function unpause(bytes32 id) external onlyAirdropAdmin(id) {
        SnagAirdropClaim(claimContractById[id]).unpause();
    }
}
