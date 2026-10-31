# Provider bonds for ERC-8183 jobs

`contracts/ERC8183BondHook.sol` adds provider performance bonds to
[ERC-8183](https://github.com/erc-8183/base-contracts) (Agentic Commerce), the
draft standard for escrowed agent jobs.

ERC-8183 holds the client's budget until an evaluator completes or rejects the
job. The provider risks nothing: if it never delivers, the client gets its own
budget back after the job expires, and that is all. With this hook attached,
the provider can put cover from its Arrha bond behind the job, and the client
receives that cover if the work doesn't arrive in time.

## Offering cover

The provider offers cover when it sets the budget, in `setBudget`'s
`optParams`:

```
optParams = abi.encode(uint256 agentId, uint256 cover, uint256 deliverBy)
```

- `agentId` is the provider's ERC-8004 agent. The caller of `setBudget` must
  be its owner or its agent wallet.
- `cover` is the amount of the agent's AgentBond put behind this job, in the
  bond token.
- `deliverBy` is a unix time: the deadline the provider commits to.

`bondTerms({ agentId, cover, deliverBy })` in `sdk/erc8183.mjs` builds it.
Empty `optParams` means no cover, and the job runs as plain ERC-8183.

## What happens at each step

| ERC-8183 step | The hook |
|---|---|
| `setBudget` (provider) | Records the offer and checks the caller acts for the agent. A new budget without terms withdraws the offer. |
| `fund` (client) | Locks the cover in AgentBond. Funding **reverts** if the agent's free bond can't cover it, if `deliverBy` has passed, or if the client is the agent itself. |
| `submit` (provider) | Records the submission time. A submission after `deliverBy` is **refused**. |
| `complete` (evaluator) | Releases the cover. |
| `reject` (evaluator) | Releases the cover, unless nothing was submitted and `deliverBy` has passed; then the cover goes to the client. Rejection on quality never slashes: the bond answers for lateness, which anyone can check. |
| `claimRefund` (anyone, after expiry) | Runs no hooks, by the standard's design. The client gets its budget back here. |
| `slashLate` (anyone, on the hook) | After `deliverBy`, with nothing submitted, pays the cover to the client. |
| `releaseStale` (anyone, on the hook) | If the work was submitted on time but the job is never settled, releases the cover `staleAfter` seconds after `deliverBy`. |

Cover committed by the agent wallet stays within the caps its owner set in
AgentBond (`setWalletLimits`). A payout the client can't receive, such as a
USDC address frozen by its issuer, is credited instead, and only the client
can collect it (`withdrawOwed`). Claim-based (streaming) ERC-8183 flows aren't
bonded.

## Deploying it

1. Deploy `ERC8183BondHook(core, bond, staleAfter, selectors)`.
   - `core` is the ERC-8183 contract. Only it can call the hook.
   - `selectors` are the selectors of that core's `setBudget`, `fund`,
     `submit`, `complete` and `reject`. `ERC8183_SELECTORS` in
     `sdk/erc8183.mjs` matches the published signatures. **Check them against
     the ABI of the core you use:** if a selector doesn't match, the hook never
     sees that action.
2. Approve the hook as a slasher in AgentBond (`proposeSlasher`). It becomes
   active after one unbonding period, like any slasher.
3. Ask the ERC-8183 core's admin to whitelist the hook. The reference
   implementation only lets clients attach whitelisted hooks.

## Status

Tested in `test/erc8183.test.mjs` against `MockERC8183`, a minimal stand-in that
follows ERC-8183's published lifecycle, roles and hook encodings. It hasn't yet
run against the reference implementation, which is the next step, and it is
unaudited like the rest of Arrha.
