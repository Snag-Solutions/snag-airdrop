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
        pure
        override
        returns (uint256[] memory stakeIds, uint256[] memory amounts)
    {
        // Return sample data
        stakeIds = new uint256[](1);
        amounts = new uint256[](1);
        stakeIds[0] = 1;
        amounts[0] = 1000;
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

