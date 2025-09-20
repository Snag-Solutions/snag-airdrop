// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SnagAirdropV2Claim} from "../Claim.sol";

/// @title MockFactoryWithRoles
/// @notice Test factory that deploys claim via CREATE2 and exposes PROTOCOL_ADMIN_ROLE for withdraw tests.
contract MockFactoryWithRoles is AccessControl {
    bytes32 public constant PROTOCOL_ADMIN_ROLE = keccak256("PROTOCOL_ADMIN_ROLE");

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PROTOCOL_ADMIN_ROLE, admin); // tests can use `admin` as protocol admin
    }

    function grantProtocolAdmin(address acct) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(PROTOCOL_ADMIN_ROLE, acct);
    }

    function revokeProtocolAdmin(address acct) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(PROTOCOL_ADMIN_ROLE, acct);
    }

    function deployClaim(
        SnagAirdropV2Claim.InitParams memory p,
        SnagAirdropV2Claim.InitFeeConfig memory cfg,
        bytes32 salt
    ) external returns (address claim) {
        bytes memory bytecode = type(SnagAirdropV2Claim).creationCode;
        assembly {
            claim := create2(0, add(bytecode, 32), mload(bytecode), salt)
            if iszero(claim) { revert(0, 0) }
        }
        SnagAirdropV2Claim(claim).initialize(p, cfg); // onlyFactory = address(this)
    }
}