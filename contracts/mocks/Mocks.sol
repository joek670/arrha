// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ISanctionsList} from "../SanctionsPolicy.sol";

/// @notice Test stand-in for USDC: 6 decimals, anyone can mint, and like the
/// real token, any transfer to or from a frozen address reverts. Implements
/// EIP-3009's receiveWithAuthorization the way FiatTokenV2 does, including
/// its revert messages.
contract MockUSDC is ERC20("Mock USDC", "mUSDC"), EIP712("Mock USDC", "2") {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => bool) public frozen;
    mapping(address authorizer => mapping(bytes32 nonce => bool)) public authorizationState;

    error AccountFrozen(address account);

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFrozen(address account, bool isFrozen) external {
        frozen[account] = isFrozen;
    }

    function version() external pure returns (string memory) {
        return "2";
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        require(ECDSA.recover(digest, v, r, s) == from, "FiatTokenV2: invalid signature");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (frozen[from]) revert AccountFrozen(from);
        if (frozen[to]) revert AccountFrozen(to);
        super._update(from, to, value);
    }
}

/// @notice Test stand-in for an ERC-8004 identity registry: only the ERC-721
/// part AgentBond and AgentEscrow use. Agent IDs count up from 1.
contract MockIdentityRegistry is ERC721("Mock ERC-8004 Agents", "AGENT") {
    uint256 public lastId;

    function register() external returns (uint256 agentId) {
        agentId = ++lastId;
        _mint(msg.sender, agentId);
    }
}

/// @notice Test stand-in for the ERC-8004 registry with agent wallets. The
/// real `setAgentWallet` also needs the wallet's EIP-712 consent; this one
/// takes the owner's word for it.
contract MockAgentRegistry is MockIdentityRegistry {
    mapping(uint256 => address) public getAgentWallet;

    function setAgentWallet(uint256 agentId, address wallet) external {
        require(ownerOf(agentId) == msg.sender, "not owner");
        getAgentWallet[agentId] = wallet;
    }
}

/// @notice Test stand-in for an on-chain sanctions list.
contract MockSanctionsList is ISanctionsList {
    mapping(address => bool) public isSanctioned;

    function set(address account, bool sanctioned) external {
        isSanctioned[account] = sanctioned;
    }
}
