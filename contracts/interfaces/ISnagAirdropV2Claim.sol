// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.20;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ILinearStake} from './ILinearStake.sol';
import {SnagFeeModule} from '../modules/SnagFeeModule.sol';

/// @title ISnagAirdropV2Claim
/// @notice Interface for Snag airdrop claim contracts.
/// @dev Concrete implementation (SnagAirdropV2Claim) should annotate functions with `@inheritdoc`.
interface ISnagAirdropV2Claim {
    /// @notice EIP-712 claim options signed by the beneficiary.
    /// @dev Percentages are in basis points (bips), where 10_000 = 100%.
    struct ClaimOptions {
        /// @notice Unique option identifier (non-zero); prevents signature replay across options.
        bytes32 optionId;
        /// @notice Bonus multiplier (bips) the signer expects; must match current multiplier on-chain.
        uint256 multiplier;
        /// @notice Immediate transfer percentage to beneficiary (bips).
        uint16  percentageToClaim;
        /// @notice Staked percentage on beneficiary's behalf (bips).
        uint16  percentageToStake;
        /// @notice Requested lockup period in seconds; must respect min lockups when staking is selected.
        uint32  lockupPeriod;
    }

    // ---------- Events ----------

    /// @notice Emitted when the bonus multiplier is updated by the admin.
    /// @param oldMultiplier Previous multiplier (bips).
    /// @param newMultiplier New multiplier (bips).
    event MultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);

    /// @notice Emitted when the airdrop is ended and non-protocol tokens are swept.
    /// @param to Recipient of the leftover tokens.
    /// @param amount Amount of tokens transferred to `to`.
    event AirdropEnded(address indexed to, uint256 amount);

    /// @notice Emitted when airdrop ownership is transferred.
    /// @param previousAdmin Previous admin address.
    /// @param newAdmin New admin address.
    event AirdropOwnershipTransferred(address indexed previousAdmin, address indexed newAdmin);

    /// @notice Emitted on successful claim.
    event Claimed(
        address indexed beneficiary,
        uint256 amountClaimed,
        uint256 amountStaked,
        uint256 bonus,
        uint256 protocolTake,
        uint32  lockupPeriod,
        address feeReceiver,
        uint256 feeWei,
        uint64  feeUsdCents,
        SnagFeeModule.FeeOverflowMode mode,
        bool    stakeSelected,
        bytes32 optionId
    );

    /// @notice Emitted after successful initialization by the factory.
    event AirdropInitialized(
        address admin,
        bytes32 root,
        address asset,
        address staking,
        uint256 maxBonus,
        uint32  minLockupDuration,
        uint32  minLockupDurationForMultiplier,
        uint256 multiplier,
        address priceFeed,
        uint32  maxPriceAge,
        address protocolTreasury,
        address protocolOverflow,
        address partnerOverflow,
        uint64  feeClaimUsdCents,
        uint64  feeStakeUsdCents,
        uint64  feeCapUsdCents,
        SnagFeeModule.FeeOverflowMode overflowMode,
        uint16  protocolTokenShareBips
    );


    // ---------- Read-only (auto getters in Claim) ----------

    /// @notice Merkle root for the allocation tree.
    function root() external view returns (bytes32);
    /// @notice ERC-20 token distributed by this airdrop.
    function tokenAsset() external view returns (IERC20);
    /// @notice Optional staking contract address (zero address if disabled).
    function stakingAddress() external view returns (ILinearStake);
    /// @notice Active multiplier (bips) for bonus calculation.
    function multiplier() external view returns (uint256);
    /// @notice Total tokens claimed directly by users (sum).
    function totalClaimed() external view returns (uint256);
    /// @notice Total tokens staked on behalf of users (sum).
    function totalStaked() external view returns (uint256);
    /// @notice Total bonus tokens distributed (sum).
    function totalBonusTokens() external view returns (uint256);
    /// @notice Minimum lockup required to allow any staking.
    function minLockupDuration() external view returns (uint32);
    /// @notice Lockup required to qualify for multiplier-based bonus.
    function minLockupDurationForMultiplier() external view returns (uint32);
    /// @notice True while airdrop is active and claims are allowed.
    function isActive() external view returns (bool);
    /// @notice Amount already consumed by a user (claim + stake) out of their allocation.
    function claimedAmount(address user) external view returns (uint256);

    /**
     * @notice Validate claim options and return the exact wei fee required for this action.
     * @dev Reverts on invalid options (percentage sum, staking constraints, multiplier mismatch).
     *      The return value reflects current cap/overflow state and USD-pegged pricing.
     * @param options The options to validate.
     * @return requiredWei Exact msg.value in wei to use with `claimFor(...)` for these options.
     */
    function validateClaimOptions(ClaimOptions calldata options) external view returns (uint256 requiredWei);

    // ---------- State-changing ----------

    /**
     * @notice Claim a portion of your allocation and optionally stake it.
     * @param beneficiary The end user receiving tokens.
     * @param proof Merkle proof for (beneficiary, totalAllocation).
     * @param totalAllocation The user's total allocation from the tree.
     * @param options Percentages + lockup + signed option id & multiplier.
     * @param signature EIP-712 signature (beneficiary as signer).
     * @return amountClaimed Tokens transferred immediately to beneficiary.
     * @return amountStaked  Tokens staked on behalf of beneficiary.
     *
     * Requirements:
     * - Contract must be active and not paused.
     * - Sum of percentages = 100% (10_000 bips). Partial claims that leave unconsumed allocation are not allowed.
     * - If staking selected: staking address must be set and lockup ≥ minimums.
     * - Signature must be from the beneficiary and optionId must be non-zero.
     * - Merkle proof must validate against the current root.
     *
     * Bonus calculation semantics:
     * - Bonus applies only when `multiplier > 0` and `amountStaked > 0`.
     * - Lockup eligibility for multiplier (lockupPeriod ≥ minLockupDurationForMultiplier) is enforced during
     *   option validation; implementations do not re-check it during the bonus calculation.
     */
    function claimFor(
        address beneficiary,
        bytes32[] calldata proof,
        uint256 totalAllocation,
        ClaimOptions calldata options,
        bytes32 nonce,
        bytes calldata signature
    ) external payable returns (uint256 amountClaimed, uint256 amountStaked);

    /// @notice Update the bonus multiplier (admin only).
    /// @param newMultiplier New multiplier (bips).
    function setMultiplier(uint256 newMultiplier) external;

    /// @notice End the airdrop and sweep remaining tokens (excluding protocol accrued share which is paid to treasury).
    /// @param to Recipient for non-protocol leftover tokens.
    function endAirdrop(address to) external;

    /// @notice Pause claim operations (admin only).
    function pause() external;

    /// @notice Unpause claim operations (admin only).
    function unpause() external;

    /// @notice Transfer admin ownership to a new address (admin only).
    /// @param newAdmin The new admin address.
    function transferOwnership(address newAdmin) external;

    /// @notice Cancel a previously signed ClaimRequest by marking its `nonce` as used for the caller.
    /// @dev After cancellation, any signature containing this nonce for the caller will revert.
    /// @param nonce The 32-byte nonce to cancel.
    function cancelNonce(bytes32 nonce) external;
}
