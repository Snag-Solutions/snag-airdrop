// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "../interfaces/IBaseStake.sol";

/// @title MockStake
/// @author Snag Protocol
/// @notice Minimal test staking contract that implements IBaseStake interface
/// @dev This contract is used for testing custom staking contract integration
/// It simply returns sample values without implementing actual staking logic.
contract MockStake is ERC165, IBaseStake {
    
    /// @inheritdoc IBaseStake
    function stakeFor(address staker, uint256 amount, uint32 duration) external override {
        // Do nothing - just accept the call
    }

    /// @inheritdoc IBaseStake
    function claimable(uint256 /* stakeId */, address /* account */)
        external
        view
        override
        returns (IBaseStake.StakeInfo[] memory stakeInfos)
    {
        // Return sample data
        stakeInfos = new IBaseStake.StakeInfo[](1);
        stakeInfos[0] = IBaseStake.StakeInfo({
            stakeId: 1,
            amount: 1000,
            duration: 86400, // 1 day
            startTime: block.timestamp,
            claimed: 0,
            claimable: 1000 // Sample claimable amount
        });
    }

    /// @inheritdoc IBaseStake
    function claimFrom(uint256 /* startAfterId */, uint256 /* maxStakes */)
        external
        pure
        override
        returns (uint256 totalClaimed, uint256 lastProcessedId)
    {
        // Return sample data
        return (0, 0);
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC165)
        returns (bool)
    {
        return
            interfaceId == type(IBaseStake).interfaceId ||
            super.supportsInterface(interfaceId);
    }
} 

