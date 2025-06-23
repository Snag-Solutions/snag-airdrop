# Snag Airdrop Contracts

A comprehensive **permissionless** airdrop system with optional staking, multiplier bonuses, and flexible claim options. Built with Hardhat and Ignition for easy deployment.

## 🔒 Protocol Security & Governance

### Permissionless Design
This is a **permissionless protocol** where:
- **No centralized control**: Snag has no control over user assets or claim processes
- **Smart contract governance**: All logic is governed by immutable smart contracts
- **Non-upgradable**: Contracts are not upgradeable, ensuring code immutability
- **User sovereignty**: Users maintain full control over their tokens and claim decisions
- **Transparent**: All operations are verifiable on-chain

### Key Security Principles
- **Immutable contracts**: Once deployed, contract logic cannot be changed
- **No admin keys**: No privileged accounts can seize or control user funds
- **Open source**: All code is publicly auditable
- **Deterministic**: Same inputs always produce the same outputs
- **Trustless**: No trust required in any third party

## 📋 Overview

The Snag Airdrop system consists of three main contracts:

### 🏗️ Core Contracts

#### `SnagAirdropRouter`
- **Purpose**: Central factory and router for all airdrops
- **Features**: 
  - Deploys new airdrop contracts
  - Handles user claims with signature verification
  - Provides admin functions (pause, unpause, end airdrop)
  - Manages multiplier settings
- **Key Functions**:
  - `deployClaimContract()` - Creates new airdrop instances
  - `claim()` - User entry point for claiming tokens
  - `getStakingData()` - Retrieves user staking information
  - `getClaimData()` - Gets comprehensive airdrop statistics

#### `SnagAirdropClaim`
- **Purpose**: Individual airdrop contract with claim logic
- **Features**:
  - Merkle proof verification for secure distribution
  - EIP-712 signature validation
  - Optional staking integration
  - Multiplier bonus system
  - Pausable functionality
- **Key Functions**:
  - `claimFor()` - Core claiming logic with staking support
  - `validateClaimOptions()` - Validates claim parameters
  - `endAirdrop()` - Allows admin to end distribution

#### `LinearStake`
- **Purpose**: Linear vesting staking contract
- **Features**:
  - Linear token vesting over time
  - Multiple stakes per user
  - Claimable amount calculations
  - ERC-165 interface support
- **Key Functions**:
  - `stakeFor()` - Creates new stakes
  - `claimUnlocked()` - Claims vested tokens
  - `claimable()` - Calculates claimable amounts

## 🚀 Deployment

### 1. Deploy the Router

First, deploy the central router contract:

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

Users can choose from various claim strategies when claiming their tokens:

### Claim Option Structure
```solidity
struct ClaimOptions {
    bytes32 optionId;        // Unique identifier for the option
    uint8  percentageToClaim; // Percentage to claim immediately (0-100)
    uint8  percentageToStake; // Percentage to stake (0-100)
    uint32 lockupPeriod;     // Staking duration in seconds
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
- **Range**: 0-100
- **Behavior**: Tokens are transferred directly to the user's wallet
- **Example**: `50` = claim 50% of allocation immediately

#### `percentageToStake`
- **Purpose**: Percentage of total allocation to stake for vesting
- **Range**: 0-100
- **Behavior**: Tokens are transferred to the staking contract with linear vesting
- **Example**: `50` = stake 50% of allocation for the specified lockup period

#### `lockupPeriod`
- **Purpose**: Duration of the staking period in seconds
- **Behavior**: Tokens vest linearly over this period
- **Requirements**: Must be >= `minLockupDuration` if staking
- **Example**: `2592000` = 30 days (30 * 24 * 60 * 60 seconds)

### Validation Rules
- `percentageToClaim + percentageToStake` must not exceed 100
- If `percentageToStake > 0`, staking contract must be configured
- If `percentageToStake > 0`, `lockupPeriod` must be >= `minLockupDuration`
- If `percentageToClaim < 100` or `percentageToStake > 0`, `optionId` must be non-zero

### Test Examples
The test suite includes various claim strategies for demonstration purposes:
- Full immediate claims (100% claim, 0% stake)
- Partial claims with staking (e.g., 50% claim, 50% stake)
- Full staking (0% claim, 100% stake)
- Various lockup periods (30, 60, 90 days)

These are just examples - you can create any combination that satisfies the validation rules.

## 🔧 Configuration Options

### Deployment Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `root` | bytes32 | Merkle root for claim verification | Required |
| `assetAddress` | address | ERC-20 token address | Required |
| `stakingAddress` | address | Staking contract address | zeroAddress |
| `multiplier` | uint256 | Bonus multiplier (in bips) | 0 |
| `minLockupDuration` | uint32 | Minimum staking duration | 0 |
| `minLockupDurationForMultiplier` | uint32 | Duration threshold for bonus | 0 |

### Multiplier System

- **Multiplier**: Bonus percentage in basis points (1000 = 10%)
- **Threshold**: Minimum lockup period to qualify for bonus
- **Calculation**: `bonus = (stakedAmount * multiplier) / 10000`

### Staking Features

- **Linear Vesting**: Tokens vest linearly over the lockup period
- **Multiple Stakes**: Users can have multiple stakes with different durations
- **Partial Claims**: Claim vested tokens before lockup ends
- **Automatic Approval**: Contract automatically approves staking contract

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

## 🔒 Security Features

### Signature Verification
- EIP-712 typed data signing
- Beneficiary address validation
- Replay attack prevention

### Access Control
- Router-only admin functions
- Pausable functionality
- Admin-only multiplier updates

### Validation
- Merkle proof verification
- Claim option validation
- Percentage sum validation
- Lockup duration checks

## 📊 Events

### Router Events
- `ClaimContractDeployed` - New airdrop deployed
- `Claimed` - User claim executed

### Staking Events
- `Staked` - New stake created
- `Claimed` - Tokens claimed from stake

## 🛠️ Development

### Prerequisites
- Node.js 18+
- pnpm (recommended) or npm
- Hardhat

### Setup
```bash
# Install dependencies
pnpm install

# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test
```

### Local Development
```bash
# Start local node
npx hardhat node

# Deploy to local network
npx hardhat ignition deploy ignition/modules/DeployAirdropRouter.ts
```
