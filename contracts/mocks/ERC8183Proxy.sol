// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice The proxy for the vendored ERC-8183 reference implementation in
/// tests. The build only exports contracts defined under `contracts/`.
contract ERC8183Proxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}
