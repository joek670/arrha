// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IAccountPolicy} from "./IAccountPolicy.sol";

/// @notice The read side of an on-chain sanctions list, such as Chainalysis's
/// free sanctions oracle (OFAC SDN addresses).
interface ISanctionsList {
    function isSanctioned(address account) external view returns (bool);
}

/// @title SanctionsPolicy
/// @notice Lets through any account the sanctions list doesn't flag.
///
/// The list's address differs by network and is not hard-coded here: check
/// the provider's documentation for the network you deploy on.
contract SanctionsPolicy is IAccountPolicy {
    ISanctionsList public immutable sanctionsList;

    constructor(ISanctionsList sanctionsList_) {
        sanctionsList = sanctionsList_;
    }

    function isAllowed(address account) external view returns (bool) {
        return !sanctionsList.isSanctioned(account);
    }
}
