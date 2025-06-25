// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {ISnagAirdropClaim} from './ISnagAirdropClaim.sol';

/// @notice Interface for the central airdrop router + factory, including custom errors.
/// @dev This contract serves as the main entry point for deploying and managing airdrops.
/// It acts as a factory for creating new airdrop claim contracts and provides
/// administrative functions for managing existing airdrops.
interface ISnagAirdropRouter {
    // ───────────── Errors ─────────────────────────────────────────

    /// @notice Thrown when trying to deploy a claim contract with an ID that already exists.
    /// @dev This prevents duplicate airdrop IDs which could cause confusion and potential security issues.
    error IdExists();

    /// @notice Thrown when the provided admin address is the zero address.
    /// @dev Ensures that every airdrop has a valid admin address for administrative functions.
    error ZeroAdmin();

    /// @notice Thrown when the override staking address does not implement IBaseStake.
    /// @dev Ensures that custom staking contracts follow the required interface for compatibility.
    error InvalidStakingAddress();

    /// @notice Thrown when referencing an airdrop ID that has not been deployed.
    /// @dev Prevents operations on non-existent airdrops.
    error InvalidId();

    /// @notice Thrown when the caller is not the configured airdrop admin.
    /// @dev Ensures only authorized admins can perform administrative functions.
    error NotAirdropAdmin();

    // ───────────── Data Types ───────────────────────────────────────

    /// @notice Comprehensive data structure returned by `getClaimData`.
    /// @dev Contains both global airdrop statistics and user-specific claim information.
    struct ClaimData {
        uint256 totalClaimed;                    /// Total tokens claimed across all users
        uint256 claimedByUser;                   /// Amount claimed by the specific user (if account != address(0))
        uint256 totalStaked;                     /// Total tokens staked across all users
        uint256 totalBonusTokens;                /// Total bonus tokens distributed via multiplier
        uint32 minLockupDuration;                /// Minimum lockup duration required for staking
        uint32 minLockupDurationForMultiplier;   /// Minimum lockup duration to qualify for bonus multiplier
        uint256 multiplier;                      /// Current bonus multiplier (in basis points)
        bool isActive;                           /// Whether the airdrop is still active
        bool isPaused;                           /// Whether the airdrop is currently paused
        address tokenAsset;                      /// Address of the ERC-20 token being distributed
        address stakingAddress;                  /// Address of the staking contract (if any)
        address admin;                           /// Address of the airdrop admin
    }

    // ───────────── Events ──────────────────────────────────────────

    /// @notice Emitted when a new claim contract is deployed.
    /// @param id The unique airdrop identifier
    /// @param root The Merkle root for claim verification
    /// @param claimContract The address of the deployed claim contract
    /// @param stakingAddress The address of the staking contract (if any)
    /// @param admin The address of the airdrop admin
    event ClaimContractDeployed(
        bytes32 indexed id,
        bytes32 indexed root,
        address indexed claimContract,
        address stakingAddress,
        address admin
    );

    /// @notice Emitted when a user claims tokens.
    /// @param id The airdrop identifier
    /// @param claimer The address of the user claiming tokens
    /// @param amountClaimed The amount of tokens claimed immediately
    /// @param amountStaked The amount of tokens staked
    /// @param percentageToClaim The percentage of allocation claimed immediately
    /// @param percentageToStake The percentage of allocation staked
    /// @param lockupPeriod The lockup period for staked tokens
    /// @param multiplier The multiplier applied to staked tokens
    event Claimed(
        bytes32 indexed id,
        address indexed claimer,
        uint256 amountClaimed,
        uint256 amountStaked,
        uint8 percentageToClaim,
        uint8 percentageToStake,
        uint32 lockupPeriod,
        uint256 multiplier
    );

    // ───────────── Read Functions ─────────────────────────────────

    /// @notice Returns the claim contract address for a given airdrop ID.
    /// @param id The unique airdrop identifier
    /// @return The address of the claim contract, or address(0) if not deployed
    /// @dev This mapping allows lookup of claim contracts by their airdrop ID.
    function claimContractById(bytes32 id) external view returns (address);

    /// @notice Returns the admin address for a given airdrop ID.
    /// @param id The unique airdrop identifier
    /// @return The address of the airdrop admin, or address(0) if not deployed
    /// @dev Only the admin can perform administrative functions on the airdrop.
    function airdropAdmin(bytes32 id) external view returns (address);

    // ───────────── Write Functions ────────────────────────────────

    /**
     * @notice Deploy a new airdrop claim contract with optional staking functionality.
     * @param id The unique airdrop identifier (must not already exist)
     * @param root The Merkle root for claim verification
     * @param multiplier The bonus multiplier in basis points (e.g., 1000 = 10% bonus)
     * @param assetAddress The ERC-20 token address to distribute
     * @param overrideStakingAddress Custom staking contract address (optional, use address(0) for default)
     * @param admin The admin address for this airdrop
     * @param withStaking Whether to enable staking functionality
     * @param minLockupDuration Minimum lockup duration in seconds for any stake
     * @param minLockupDurationForMultiplier Minimum lockup duration to qualify for bonus multiplier
     * @return The address of the deployed claim contract
     * @dev This function creates a new airdrop with the specified parameters.
     * If withStaking is true and no override staking address is provided,
     * a new LinearStake contract will be deployed automatically.
     * The admin address cannot be the zero address.
     * 
     * Example usage:
     * ```solidity
     * address claimContract = router.deployClaimContract(
     *     keccak256("my-airdrop"),
     *     merkleRoot,
     *     1000, // 10% bonus
     *     tokenAddress,
     *     address(0), // Use default staking
     *     adminAddress,
     *     true, // Enable staking
     *     30 days, // Minimum lockup
     *     60 days  // Lockup for bonus
     * );
     * ```
     */
    function deployClaimContract(
        bytes32  id,
        bytes32  root,
        uint256  multiplier,
        address  assetAddress,
        address  overrideStakingAddress,
        address  admin,
        bool     withStaking,
        uint32   minLockupDuration,
        uint32   minLockupDurationForMultiplier
    ) external returns (address);

    /**
     * @notice Claim tokens and optionally stake them in a single transaction.
     * @param id The airdrop identifier
     * @param beneficiary The address that will receive the tokens
     * @param proof The Merkle proof for the beneficiary's allocation
     * @param totalAllocation The total allocation amount for the beneficiary
     * @param options The claim options specifying percentages and lockup period
     * @param signature The EIP-712 signature authorizing this claim
     * @dev This function handles the complete claim process including:
     * - Signature verification
     * - Merkle proof validation
     * - Token distribution (immediate claim + staking)
     * - Bonus multiplier application
     * 
     * The beneficiary can only claim once per airdrop.
     * The signature must be created by the beneficiary.
     * 
     * Example usage:
     * ```solidity
     * ISnagAirdropClaim.ClaimOptions memory options = ISnagAirdropClaim.ClaimOptions({
     *     optionId: keccak256("my-option"),
     *     percentageToClaim: 50,  // Claim 50% immediately
     *     percentageToStake: 50,  // Stake 50%
     *     lockupPeriod: 90 days   // 90-day lockup
     * });
     * 
     * router.claim(
     *     airdropId,
     *     beneficiary,
     *     merkleProof,
     *     totalAllocation,
     *     options,
     *     signature
     * );
     * ```
     */
    function claim(
        bytes32 id,
        address beneficiary,
        bytes32[] calldata proof,
        uint256 totalAllocation,
        ISnagAirdropClaim.ClaimOptions calldata options,
        bytes calldata signature
    ) external;

    /**
     * @notice Get the staking contract address for a specific airdrop.
     * @param id The airdrop identifier
     * @return The address of the staking contract, or address(0) if no staking is enabled
     * @dev This function returns the staking contract that was deployed with the airdrop.
     * If the airdrop doesn't exist, it will revert with InvalidId.
     */
    function getStakingAddress(bytes32 id) external view returns (address);

    /**
     * @notice Get comprehensive claim data for an airdrop and optionally a specific user.
     * @param id The airdrop identifier
     * @param account The user address to get data for (use address(0) for global data only)
     * @return data A ClaimData struct containing all relevant airdrop information
     * @dev This function provides a complete overview of the airdrop status including:
     * - Global statistics (total claimed, staked, bonus tokens)
     * - Configuration parameters (lockup durations, multiplier)
     * - Contract state (active, paused)
     * - User-specific data (if account is provided)
     * 
     * If account is address(0), only global data is returned.
     * If the airdrop doesn't exist, it will revert with InvalidId.
     */
    function getClaimData(
        bytes32 id,
        address account
    ) external view returns (ClaimData memory data);

    /**
     * @notice Get staking data for a specific user in an airdrop.
     * @param id The airdrop identifier
     * @param account The user address to get staking data for
     * @return stakeIds Array of stake IDs owned by the user
     * @return claimableAmounts Array of claimable amounts for each stake
     * @return totalClaimable Total amount claimable across all stakes
     * @dev This function provides detailed staking information for a user including:
     * - All active stake IDs
     * - Current claimable amount for each stake
     * - Total claimable amount across all stakes
     * 
     * If no staking contract is configured, empty arrays are returned.
     * If the airdrop doesn't exist, it will revert with InvalidId.
     * 
     * Example usage:
     * ```solidity
     * (uint256[] memory ids, uint256[] memory amounts, uint256 total) = 
     *     router.getStakingData(airdropId, userAddress);
     * 
     * for (uint i = 0; i < ids.length; i++) {
     *     console.log("Stake", ids[i], "claimable:", amounts[i]);
     * }
     * console.log("Total claimable:", total);
     * ```
     */
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
        );

    /**
     * @notice Update the bonus multiplier for an airdrop (admin only).
     * @param id The airdrop identifier
     * @param newMultiplier The new multiplier value in basis points (e.g., 1000 = 10%)
     * @dev This function allows the airdrop admin to adjust the bonus multiplier.
     * The multiplier affects future stakes, not existing ones.
     * Only the airdrop admin can call this function.
     * 
     * Example usage:
     * ```solidity
     * // Set 15% bonus multiplier
     * router.setMultiplier(airdropId, 1500);
     * ```
     */
    function setMultiplier(bytes32 id, uint256 newMultiplier) external;

    /**
     * @notice End an airdrop and transfer remaining tokens to a specified address (admin only).
     * @param id The airdrop identifier
     * @param to The address to receive the remaining tokens
     * @dev This function permanently ends the airdrop and transfers any remaining tokens.
     * After calling this function:
     * - No new claims can be made
     * - The airdrop becomes inactive
     * - Remaining tokens are sent to the specified address
     * 
     * Only the airdrop admin can call this function.
     * 
     * Example usage:
     * ```solidity
     * // End airdrop and send remaining tokens to treasury
     * router.endAirdrop(airdropId, treasuryAddress);
     * ```
     */
    function endAirdrop(bytes32 id, address to) external;

    /**
     * @notice Pause claim functionality for an airdrop (admin only).
     * @param id The airdrop identifier
     * @dev This function pauses all claim operations for the specified airdrop.
     * While paused:
     * - Users cannot claim tokens
     * - Existing stakes continue to vest normally
     * - Admin functions remain available
     * 
     * Only the airdrop admin can call this function.
     * Use unpause() to resume claim functionality.
     */
    function pause(bytes32 id) external;

    /**
     * @notice Unpause claim functionality for an airdrop (admin only).
     * @param id The airdrop identifier
     * @dev This function resumes claim operations for the specified airdrop.
     * After unpausing:
     * - Users can claim tokens again
     * - All functionality is restored
     * 
     * Only the airdrop admin can call this function.
     * This function can only be called if the airdrop is currently paused.
     */
    function unpause(bytes32 id) external;
}
