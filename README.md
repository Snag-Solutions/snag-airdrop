# Snag Airdrop Contracts

## 📋 Executive Summary

The Snag Airdrop Protocol is a comprehensive, permissionless token distribution system designed to enable partners to create and manage on-chain token airdrops with optional staking and bonus mechanisms. The protocol consists of three core contracts: `SnagAirdropRouter`, `SnagAirdropClaim`, and `LinearStake`.

### Key Features
- **Permissionless Design**: No centralized control over user assets or claim processes
- **Flexible Claim Options**: Users can choose to claim tokens immediately, stake them, or use a combination of both
- **Multiplier Bonus System**: Configurable bonus tokens for users who stake their allocations
- **Merkle Tree Verification**: Secure, gas-efficient claim verification using Merkle proofs
- **EIP-712 Signature Validation**: Secure claim option verification with typed data signing
- **Linear Vesting Staking**: Built-in staking contract with linear token vesting over time
- **Custom Staking Integration**: Support for partner-specific staking contracts via `IBaseStake` interface
- **Admin Controls**: Pause/unpause functionality and multiplier updates for airdrop administrators

### Protocol Architecture
The protocol prioritizes ease of integration by using the `SnagAirdropRouter` as the single entry point for all interactions. Partners deploy claim contracts through the router, and users claim tokens through the router, which handles all the complex logic internally.

### Security Model
- **Immutable Contracts**: Once deployed, contract logic cannot be changed
- **No Admin Keys**: No privileged accounts can seize or control user funds
- **Deterministic Operations**: Same inputs always produce the same outputs
- **Trustless Design**: No trust required in any third party

---

A comprehensive **permissionless** airdrop system with optional staking, multiplier bonuses, and flexible claim options. Built with Hardhat and Ignition for easy deployment.


## 📋 Overview

The Snag Airdrop system consists of three main contracts:

## 🏗️ Core Contracts

### `SnagAirdropRouter`
- **Purpose**: Central factory and router for all airdrop operations
- **Key Role**: Single entry point for all protocol interactions
- **Features**: 
  - Deploys new airdrop contracts with partner-specific configurations
  - Handles user claims with EIP-712 signature verification
  - Provides admin function routing (pause, unpause, end airdrop, update multiplier)
  - Manages staking contract integration
  - Retrieves comprehensive airdrop and staking data
- **Key Functions**:
  - `deployClaimContract()` - Creates new airdrop instances with full configuration
  - `claim()` - User entry point for claiming tokens with signature validation
  - `getStakingData()` - Retrieves user staking information and claimable amounts
  - `getClaimData()` - Gets comprehensive airdrop statistics and user-specific data
  - `setMultiplier()` - Updates bonus multiplier (admin only)
  - `endAirdrop()` - Permanently ends airdrop and recovers remaining tokens (admin only)
  - `transferOwnership()` - Transfers airdrop administration to new address (admin only)

### `SnagAirdropClaim`
- **Purpose**: Individual airdrop contract with comprehensive claim logic
- **Key Role**: Handles the core airdrop functionality for a specific partner
- **Features**:
  - Merkle proof verification for secure, gas-efficient distribution
  - EIP-712 signature validation for claim options
  - Optional staking integration with bonus multiplier system
  - Configurable lockup durations and multiplier thresholds
  - Pausable functionality for emergency controls
  - One-time claim enforcement per beneficiary
- **Key Functions**:
  - `claimFor()` - Core claiming logic with staking and bonus support
  - `validateClaimOptions()` - Validates claim parameters and percentages
  - `endAirdrop()` - Allows admin to end distribution and recover tokens
  - `setMultiplier()` - Updates bonus multiplier (router only)
  - `pause()/unpause()` - Emergency controls (router only)

### `LinearStake`
- **Purpose**: Multi-position linear vesting staking contract
- **Key Role**: Provides built-in staking functionality with linear token vesting
- **Features**:
  - Linear token vesting over specified durations
  - Multiple stakes per user with different lockup periods
  - Real-time claimable amount calculations
  - ERC-165 interface support for custom integration
  - Automatic token approval and transfer handling
- **Key Functions**:
  - `stakeFor()` - Creates new stakes with specified amounts and durations
  - `claimUnlocked()` - Claims vested tokens from specific stakes
  - `claimable()` - Calculates claimable amounts for all user stakes
  - `getStakeInfo()` - Retrieves detailed information about specific stakes

## 🚀 Deployment

### 0. Install
First install packages
```bash
pnpm install
```

### 1. Deploy the Router

Deploy the central router contract:

```bash
npx hardhat ignition deploy \
    ignition/modules/DeployAirdropRouter.ts \
    --network <network-name> \
    --strategy create2
```

### 2. Deploy Individual Airdrops

Deploy a basic airdrop contract:

```bash
npx hardhat ignition deploy ignition/modules/DeployBasicClaim.ts \
  --network <your-network> \
  --param root=0xYourMerkleRootHere \
  --param assetAddress=0xYourTokenAddressHere
```

### 3. Advanced Deployment Options

For more complex deployments, you can create custom Ignition modules with additional parameters:

```typescript
// Example: Deploy with staking and multiplier
const claim = m.contract("SnagAirdropClaim", [
  root,                    // Merkle root
  assetAddress,           // Token address
  stakingAddress,         // Staking contract (or zeroAddress)
  1000,                   // Multiplier (10% = 1000 bips)
  86400,                  // Min lockup duration (1 day)
  2592000,                // Min lockup for multiplier (30 days)
]);
```

## 🎯 Claim Options

Users can choose from various claim strategies when claiming their tokens through the router. The protocol uses **basis points (bips)** for percentage calculations, where 10,000 bips = 100%.

### Claim Option Structure
```solidity
struct ClaimOptions {
    bytes32 optionId;           // Unique identifier for the option
    uint16 percentageToClaim;   // Percentage to claim immediately (0-10,000 bips)
    uint16 percentageToStake;   // Percentage to stake (0-10,000 bips)
    uint32 lockupPeriod;        // Staking duration in seconds
}
```

### Understanding Claim Option Values

#### `optionId`
- **Purpose**: Unique identifier for the claim option
- **Usage**: Used for off-chain tracking and validation
- **Example**: `keccak256("my-custom-option")` or any unique bytes32 value
- **Note**: Must be non-zero when staking or partial claiming

#### `percentageToClaim`
- **Purpose**: Percentage of total allocation to claim immediately
- **Range**: 0-10,000 bips (0-100%)
- **Behavior**: Tokens are transferred directly to the user's wallet
- **Examples**: 
  - `10_000` = claim 100% of allocation immediately
  - `5_000` = claim 50% of allocation immediately
  - `0` = no immediate claim

#### `percentageToStake`
- **Purpose**: Percentage of total allocation to stake for vesting
- **Range**: 0-10,000 bips (0-100%)
- **Behavior**: Tokens are transferred to the staking contract with linear vesting
- **Examples**:
  - `10_000` = stake 100% of allocation
  - `7_000` = stake 70% of allocation
  - `0` = no staking

#### `lockupPeriod`
- **Purpose**: Duration of the staking period in seconds
- **Behavior**: Tokens vest linearly over this period
- **Requirements**: Must be >= `minLockupDuration` if staking
- **Examples**: 
  - `2592000` = 30 days (30 * 24 * 60 * 60 seconds)
  - `86400` = 1 day (24 * 60 * 60 seconds)
  - `0` = no lockup (for immediate claims only)

### Validation Rules
- `percentageToClaim + percentageToStake` must not exceed 10,000 bips (100%)
- If `percentageToStake > 0`, staking contract must be configured
- If `percentageToStake > 0`, `lockupPeriod` must be >= `minLockupDuration`
- If `percentageToClaim < 10_000` or `percentageToStake > 0`, `optionId` must be non-zero
- The beneficiary must sign their claim options using EIP-712 typed data

### Multiplier Bonus System
When staking is enabled and the user's `lockupPeriod` meets the `minLockupDurationForMultiplier` threshold:
- **Bonus Calculation**: `bonus = (stakedAmount * multiplier) / 10_000`
- **Maximum Cap**: Bonus is capped at `maxBonus` tokens per user
- **Distribution**: Bonus tokens are automatically staked with the same lockup period

### Test Examples
The test suite includes various claim strategies for demonstration purposes:
- **Full Immediate Claims**: `percentageToClaim: 10_000, percentageToStake: 0`
- **Partial Claims with Staking**: `percentageToClaim: 3_000, percentageToStake: 7_000`
- **Full Staking**: `percentageToClaim: 0, percentageToStake: 10_000`
- **Various Lockup Periods**: 30, 60, 90 days with different multiplier thresholds

These are just examples - users can create any combination that satisfies the validation rules.

## 🔧 Configuration Options

### Deployment Parameters

| Parameter | Type | Description | Default | Requirements |
|-----------|------|-------------|---------|--------------|
| `id` | bytes32 | Unique airdrop identifier | Required | Must be unique across all airdrops |
| `root` | bytes32 | Merkle root for claim verification | Required | Contains `[address, uint256]` pairs |
| `multiplier` | uint256 | Bonus multiplier in basis points | 0 | 1000 = 10% bonus |
| `maxBonus` | uint256 | Maximum bonus tokens per user | maxUint256 | Caps total bonus per user |
| `assetAddress` | address | ERC-20 token address | Required | Token being distributed |
| `overrideStakingAddress` | address | Custom staking contract | zeroAddress | Must implement `IBaseStake` |
| `admin` | address | Airdrop administrator | Required | Cannot be zero address |
| `withStaking` | bool | Enable staking functionality | true | Deploys `LinearStake` if true |
| `minLockupDuration` | uint32 | Minimum staking duration | 0 | Required if staking enabled |
| `minLockupDurationForMultiplier` | uint32 | Duration threshold for bonus | 0 | Minimum time for multiplier |

### Multiplier System

The multiplier system provides bonus tokens to users who stake their allocations:

- **Multiplier**: Bonus percentage in basis points (1000 = 10%, 2000 = 20%)
- **Threshold**: Minimum lockup period to qualify for bonus (`minLockupDurationForMultiplier`)
- **Calculation**: `bonus = (stakedAmount * multiplier) / 10_000`
- **Maximum Cap**: Bonus is capped at `maxBonus` tokens per user
- **Distribution**: Bonus tokens are automatically staked with the same lockup period

**Example Scenarios:**
- Multiplier: 1000 bips (10%), Threshold: 30 days
  - User stakes for 20 days → No bonus
  - User stakes for 60 days → 10% bonus on staked amount
- Multiplier: 2000 bips (20%), Max Bonus: 1000 tokens
  - User stakes 10,000 tokens → 2000 token bonus (capped at 1000)

### Staking Features

#### Built-in LinearStake Contract
- **Linear Vesting**: Tokens vest linearly over the lockup period
- **Multiple Stakes**: Users can have multiple stakes with different durations
- **Partial Claims**: Claim vested tokens before lockup ends
- **Automatic Approval**: Contract automatically approves staking contract
- **Real-time Calculations**: Claimable amounts calculated on-demand

#### Custom Staking Integration
Partners can provide their own staking contracts that must:
- Implement the `IBaseStake` interface
- Support `stakeFor(address user, uint256 amount, uint32 duration)` function
- Support `claimable(uint256 from, address user)` function
- Handle token transfers and vesting logic according to their own rules

### Security Configuration

#### Merkle Tree Security
- **Immutable Root**: Merkle root cannot be changed after deployment
- **One-time Claims**: Each proof can only be used once per beneficiary
- **Duplicate Prevention**: No duplicate allocations allowed in the Merkle tree
- **Gas Efficiency**: Merkle proofs provide efficient verification

#### Access Control
- **Router-only Functions**: Core functions can only be called through the router
- **Admin Controls**: Only airdrop admin can pause, unpause, update multiplier, and transfer ownership
- **Ownership Transfer**: Airdrop admins can transfer ownership to new addresses (cannot be zero address)
- **Signature Validation**: All claim options must be signed by the beneficiary
- **Pausable Operations**: Emergency pause functionality for all claim operations

## 🧪 Testing

### Run All Tests
```bash
npm test
```

### Run Specific Test Suites
```bash
# Claim tests only
npx hardhat test test/Claim.ts

# Staking tests only
npx hardhat test test/Stake.ts

# Run with gas reporting
REPORT_GAS=true npx hardhat test
```

### Test Coverage
```bash
npx hardhat coverage
```

### Test Structure

#### Claim Tests (`test/Claim.ts`)
- Admin flows (deploy, cancel, update multiplier)
- User claim flows (full claim, partial claim, staking)
- Multiplier logic (thresholds, bonus calculations)
- Data retrieval (staking data, claim data)
- Error handling (OutOfTokens, invalid signatures)

#### Staking Tests (`test/Stake.ts`)
- Staking validation (amount, duration checks)
- Stake creation and management
- Linear vesting calculations
- Token claiming functionality
- Multiple stakes handling
- Edge cases (short/long durations)

### Helper Functions

The test suite includes comprehensive helper functions:

#### Shared Helpers (`test/helpers/shared.ts`)
- `deployFixture()` - Basic test setup
- `deployStakeFixture()` - Staking test setup
- `verifyUserBalance()` - Balance verification
- `getBalanceChange()` - Balance change tracking

#### Claim Helpers (`test/helpers/claim.ts`)
- `setupClaimTest()` - Complete claim test environment
- `executeClaim()` - Claim execution with signature
- `deployClaimContract()` - Contract deployment helpers
- `verifyClaimStakingData()` - Staking data verification

#### Stake Helpers (`test/helpers/stake.ts`)
- `verifyStakingData()` - Staking data verification
- `verifyStakeCreated()` - Stake creation verification
- `setupMultipleStakes()` - Multiple stake setup