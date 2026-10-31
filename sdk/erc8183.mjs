// Helpers for ERC-8183 jobs bonded through ERC8183BondHook.
import { encodeAbiParameters, toFunctionSelector } from 'viem';

/// The `optParams` a provider passes to ERC-8183's setBudget to offer cover:
/// which ERC-8004 agent's bond backs the job, how much, and the deadline after
/// which a missing submission can be slashed. Times are unix seconds.
export function bondTerms({ agentId, cover, deliverBy }) {
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [BigInt(agentId), BigInt(cover), BigInt(deliverBy)],
  );
}

/// Hook selectors for a core whose functions have these signatures, as in
/// ERC-8183's published flow. Check them against the ABI of the core you
/// deploy the hook for: a mismatch means the hook never sees the action.
export const ERC8183_SELECTORS = {
  setBudget: toFunctionSelector('setBudget(uint256,address,uint256,bytes)'),
  fund: toFunctionSelector('fund(uint256,address,uint256,bytes)'),
  submit: toFunctionSelector('submit(uint256,bytes32,bytes)'),
  complete: toFunctionSelector('complete(uint256,bytes32,bytes)'),
  reject: toFunctionSelector('reject(uint256,bytes32,bytes)'),
};
