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
- `deliverBy` is a unix time: the deadline the provider commits to. It must
  be before the job's `expiredAt`, because the core refuses a submission from
  `expiredAt` on.

`bondTerms({ agentId, cover, deliverBy })` in `sdk/erc8183.mjs` builds it.
Empty `optParams` means no cover, and the job runs as plain ERC-8183.

## What happens at each step

| ERC-8183 step | The hook |
|---|---|
| `setBudget` (provider) | Records the offer. Checks that the caller acts for the agent and that `deliverBy` is before the job's expiry. A new budget without terms withdraws the offer. |
| `fund` (client) | Locks the cover in AgentBond. Funding **reverts** if the agent's free bond can't cover it, if `deliverBy` has passed, or if the client is the agent itself. |
| `submit` (provider) | Records the submission time. A submission after `deliverBy` is **refused**. |
| `complete` (evaluator) | Releases the cover. |
| `reject` (evaluator) | Releases the cover, unless nothing was submitted and `deliverBy` has passed; then the cover goes to the client. Rejection on quality never slashes: the bond answers for lateness, which anyone can check. |
| `claimRefund` (anyone, after expiry) | Runs no hooks, by the standard's design. The client gets its budget back here. |
| `slashLate` (anyone, on the hook) | After `deliverBy`, with nothing submitted by then, pays the cover to the client. |
| `releaseStale` (anyone, on the hook) | If the work was submitted on time but the job is never settled, releases the cover `staleAfter` seconds after `deliverBy`. |

Cover committed by the agent wallet stays within the caps its owner set in
AgentBond (`setWalletLimits`). A payout the client can't receive, such as a
USDC address frozen by its issuer, is credited instead, and only the client
can collect it (`withdrawOwed`).

Milestone claims (`submitClaim`, `settleClaim`, `approveClaim`,
`rejectClaim`) are not delivery, and the hook ignores them. A provider that is
paid through claims must still call `submit` by `deliverBy`, or its cover can
be slashed.

## What the hook trusts the core for

The hook reads the core's job record (`getJob`, as the reference
implementation returns it). It uses the record to check `deliverBy` against
the job's expiry, and to see a submission that the hook itself missed.

**The core's admin is trusted.** In the reference implementation:

- The admin can detach the hook from a job (`batchDetachHook`). After that,
  the hook sees none of the job's later steps. A submission made by
  `deliverBy` still counts, from the core's record: `slashLate` refuses, and
  `releaseStale` frees the cover `staleAfter` seconds after `deliverBy`. A
  late submission can still be slashed. If the admin detaches the hook before
  the client funds, the job runs without cover. A client can check that
  `getJob(jobId).hook` is the hook before it funds.
- The admin can pause the core. The core refuses `submit` while it is paused,
  and the hook can't tell how long a pause lasted. **A pause that spans
  `deliverBy` can get an on-time provider slashed.**

Offer cover only on cores whose admin you trust.

## Deploying it

1. Deploy `ERC8183BondHook(core, bond, staleAfter, selectors)`.
   - `core` is the ERC-8183 contract. Only it can call the hook. Its
     `getJob` must return the reference implementation's job record.
   - `selectors` are the selectors of that core's `setBudget`, `fund`,
     `submit`, `complete` and `reject`. `ERC8183_SELECTORS` in
     `sdk/erc8183.mjs` matches the published signatures. **Check them against
     the ABI of the core you use:** if a selector doesn't match, the hook never
     sees that action.
2. Approve the hook as a slasher in AgentBond (`proposeSlasher`). It becomes
   active after one unbonding period, like any slasher.
3. Ask the ERC-8183 core's admin to whitelist the hook (`setHookWhitelist`)
   and to allow the payment token (`setPaymentTokenAllowed`). The reference
   implementation accepts only whitelisted hooks and allowed tokens.

## Status

`test/erc8183.test.mjs` runs every scenario against three cores:

- `MockERC8183`, a minimal stand-in that follows ERC-8183's published
  lifecycle, roles, hook encodings and job record.
- `ERC8183`, the reference implementation from
  [erc-8183/base-contracts](https://github.com/erc-8183/base-contracts) at
  commit `142e669`, behind its proxy.
- `ERC8183WithAuthorization`, the same implementation with EIP-712 signed
  authorizations, at the same commit.

The reference contracts are vendored unmodified in
`contracts/mocks/erc8183-reference/`. The reference-only tests cover admin
detaches, milestone claims, pauses, and a bonded job whose steps a
facilitator relays from signatures. That is the flow that x402's proposed
`job-escrow` scheme uses. The hook is unaudited like the rest of Arrha.

**`ERC8183WithAuthorization` is over EIP-170's contract size limit.** With the
upstream compiler settings (solc 0.8.28, optimizer at 200 runs, Cancun), its
runtime code is 27,574 bytes. The limit is 24,576 bytes. With via-IR it is
26,167 bytes. A chain that enforces EIP-170 can't deploy it as it is, so the
tests lift the limit for that contract only. `ERC8183` alone is 20,960 bytes.
