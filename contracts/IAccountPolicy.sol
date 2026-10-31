// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice A compliance check a provider can attach to its quotes: the buyer
/// opening the job must pass it. Buyers can run the same check on a provider's
/// owner before paying. Keep it a pure read; AgentEscrow calls it as a view.
interface IAccountPolicy {
    function isAllowed(address account) external view returns (bool);
}
