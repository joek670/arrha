# Arrha

**Performance bonds for AI agents.** When an agent misses its deadline, the
buyer is refunded and compensated automatically.

> **Unaudited. Test networks only.** Don't use Arrha with real money until an
> independent audit is done. See [SECURITY.md](SECURITY.md).

New to crypto or AI agents? Read [Arrha, explained for beginners](docs/for-beginners.md).

```
npm install
npm test        # compile + 92 tests on an in-process EVM, including a short fuzz run
npm run demo    # two jobs end to end, then the agent's risk report
npm run fuzz    # longer invariant-fuzzing campaigns (FUZZ_SEEDS, FUZZ_STEPS)
npm run gas     # gas for deploying and for each step of a job
```

No node to run, no compiler to download, no API key: the compiler is solc's
WebAssembly build, and the tests run on an in-process EVM (`@ethereumjs/vm`)
behind a small JSON-RPC shim, so the SDK runs through viem exactly as it would
against Base.

The name is the Roman-law word for earnest money: a deposit forfeited by
whoever fails to perform.

## Why

AI agents now pay each other: x402, Tempo and Arc move the money. Coinbase's
Commerce Payments Protocol and the draft ERC-8183 job standard go further and
hold the money until the work is done. In all of them, though, the provider
risks nothing. If it fails, the buyer at best gets its own money back.
**Arrha makes the provider put money behind each job, and pays it to the buyer
automatically when the provider misses the deadline.**

| | x402 / Tempo / Arc | Commerce Payments | ERC-8183 (draft) | **Arrha** |
|---|---|---|---|---|
| Pays per request | yes | yes | yes | uses theirs |
| Holds money until the work is done | no (payment is final) | yes | yes | yes |
| Provider stake at risk on each job | no | no | no | **yes, signed per job** |
| A missed deadline costs the provider | no | no (payer reclaims after expiry) | no (client refunded on expiry) | **yes: refund plus the cover, no judge needed** |
| Who judges quality | nobody | an operator | the job's evaluator | an arbiter, capped at the cover |
| Track record anyone can check | no | no | optional hooks | **risk score from settled jobs, with reasons** |
| Keeps settling when an address is frozen | n/a | not documented | not documented | **yes** |
| Needs a new chain or token | own chain (Tempo, Arc) | no | no | **no: contracts on Base** |

Arrha doesn't compete with ERC-8183: [`ERC8183BondHook`](docs/erc-8183-hook.md)
adds the same bonds to ERC-8183 jobs.

## How it works

1. **Bond.** The owner of an ERC-8004 agent deposits USDC into `AgentBond` for
   that agent ID.
2. **Quote.** For each job the provider signs an EIP-712 quote: price, the bond
   it puts behind the job (*cover*), deadline, quote expiry, a hash of the job
   spec, and optionally a *policy* the buyer must pass. The quote travels with
   the provider's x402 402 response (`toX402Extra`).
3. **Check.** The buyer reads the quote (`fromX402Requirements`) and checks that
   the cover is really free in the bond, that it passes the quote's policy, and
   that the provider passes its own screen (`checkTrust`). `agentRiskReport`
   scores the agent's record.
4. **Open.** The buyer opens the job in `AgentEscrow`. The payment goes into
   escrow and the cover is locked, so it can't be withdrawn or promised to
   another job. There are two ways to pay:
   - `openJob`: approve USDC, then open.
   - `openJobWithAuthorization`: the buyer signs one USDC (EIP-3009)
     authorisation and anyone relays it. The buyer sends no transaction and
     needs no ETH. The authorisation's nonce is the quote's digest, so it pays
     for that quote and nothing else.
5. **Settle.** One of:
   - **Delivered:** the provider submits a result hash. The buyer releases the
     payment, or anyone claims it once the 24-hour review window passes. The
     provider is paid, minus the protocol fee (0.5%, capped at 1%).
   - **Late:** the deadline passes with no submission. Anyone can call
     `refundLate`, and the buyer gets the payment back **plus the full cover**.
     The contract checks the clock itself, so no judgement is needed.
   - **Disputed:** the buyer disputes within the review window. The arbiter
     splits the payment and slashes up to the cover. If the arbiter does
     nothing for 3 days, the buyer is refunded and the cover is unlocked.

Every settlement emits `JobSettled(jobId, agentId, outcome, ...)`. An indexer
can turn those into ERC-8004 reputation feedback: delivered and late jobs
need no human judgement.

**Owner and agent wallet.** ERC-8004 lets an agent's owner register a verified
*agent wallet*, the hot key the agent runs on. That wallet can sign quotes and
submit results, and it is paid. The owner can do the same, and only the owner
can withdraw the bond, so the owner's key can stay cold. The owner can also cap
the cover the agent wallet commits, per job and per day (`setWalletLimits`), so
a leaked hot key can only lose so much.

## Selling over x402

`sdk/x402.mjs` runs the whole round trip over HTTP, in x402's version 1
message format with a scheme named `arrha`.

```js
import { createServer } from 'node:http';
import { arrhaFetch, arrhaPaywall } from './sdk/x402.mjs';

// Provider: answer unpaid requests with a bonded offer, serve paid ones.
createServer(arrhaPaywall({
  publicClient, walletClient, signer, // signer acts for the agent
  escrow, bond, asset: usdc, network: 'base-sepolia', agentId,
  price: 2_000_000n, cover: 5_000_000n, deliverWithin: 3600, // $2, $5 cover, 1 hour
  produce: async (req) => ({ body: { translation: 'bonjour' } }),
})).listen(8080);

// Buyer: refuse offers with less cover than the price; otherwise pay and fetch.
const { response, jobId } = await arrhaFetch(url, {}, { publicClient, walletClient, minCoverBps: 10_000 });
```

- An unpaid request gets HTTP 402 with a freshly signed quote.
- `arrhaFetch` runs `checkTrust`, opens the job, and repeats the request with
  an `X-PAYMENT` header naming the job. With `gasless: true` the buyer only
  signs, and a relayer of its choice opens the job.
- The paywall serves each job once, and only if it was opened from a quote the
  paywall issued, for at least the quoted price and cover. It submits a hash
  of the response on-chain as the result and returns the transaction in
  `X-PAYMENT-RESPONSE`. The buyer then releases the payment, or anyone claims
  it for the provider after the review window.

## Built for regulated dollars

- **Freezes can't jam settlement.** Circle can freeze a USDC address, after
  which every transfer to or from it reverts. The US GENIUS Act requires every
  permitted issuer to be able to freeze tokens on a lawful order. A plain
  escrow that pays a frozen address reverts the whole settlement and can leave
  a bond locked for good. Arrha credits a failed payout to its recipient
  (`owed`) and carries on; only the recipient can collect it later, so a
  freeze can't be sidestepped.
- **Compliance is opt-in, per quote.** A provider that must screen its buyers
  names an `IAccountPolicy` in its quotes. `SanctionsPolicy` wraps an on-chain
  sanctions list such as Chainalysis's oracle. A KYC policy could read
  Coinbase's Verifications attestations on Base. Buyers can apply the same
  policies to providers.
- **Revenue is checkable on-chain.** `totalVolume` and `totalFees` are running
  totals in the escrow.

## Risk report

`sdk/risk.mjs` scores a provider agent from its paid, settled jobs and its
bond, never from reviews. A 2026 study of ERC-8004 found that 59–91% of
reviewers left coordinated Sybil feedback. Here every data point is a payment
that went through escrow, so faking a record costs real fees.

```
Agent #1: score 30/100, high risk
  - 1 delivered, 1 late, 0 lost dispute(s) out of 2 settled job(s)
  - counts as 1.5 job(s) once older jobs, small jobs and repeat buyers are weighted down
  - on-time delivery estimated at 55%; at least 30% with 90% confidence
```

How the score is built:

- **A Beta estimate of the chance the agent delivers**, from a neutral
  Beta(2, 2) prior, so a thin record reads as "unknown", not "trusted".
- **Exponential decay** with a 90-day half-life.
- **Log-scaled job size:** a $10 job counts as one job, a $1,000 job as about
  three.
- **Diminishing repeat buyers:** a buyer's second, third and fourth jobs count
  1/2, 1/3, 1/4…, so one buyer, or an operator buying from itself, can't build
  a record alone.
- **The 90% lower bound of the estimate is the score**, so it only rises with
  evidence. Four good jobs from four buyers score 57; sixteen score 82.
- **Capital flags on top:** no free bond, bond below the usual job size, bond
  being withdrawn, or one buyer making up most of the volume.

The settings live in `MODEL` and are starting points, to tune once real
settlement data exists.

## Safety and testing

Each property below has a test, and the checks behind the important ones were
mutation-tested: remove the check and the test fails.

- Nobody can lock an agent's bond without a signature from its owner or agent
  wallet. Signatures are bound to the escrow and chain, used once, and expire.
  ERC-1271 smart accounts are supported.
- A quote can't promise cover the agent doesn't have free, and an agent
  wallet can't commit more than its owner's caps.
- An escrow or hook can only slash what **it** locked, and an arbiter can never
  slash more than the cover the provider signed for.
- Withdrawals wait out a 7-day unbonding period, and bond waiting to be
  withdrawn can't back new jobs.
- A new escrow or hook only becomes active a full unbonding period after it is
  proposed, so agents can leave first. A retired one can't take new jobs but
  still settles its open ones.
- The fee for a job is fixed when the job opens, and capped at 1%.
- Payment goes to the agent's payee as of settlement: its agent wallet if it
  has one, else whoever owns the agent.
- A frozen buyer, provider or treasury can't block settlement.
- A quote's policy is enforced at opening; policies are called read-only.
- An agent can't hire itself, through its owner or its agent wallet.
- A gasless authorisation pays for its own quote only, can't be replayed, and
  only the escrow can redeem it.
- Amounts too large for the packed job record revert instead of being
  truncated.
- The owner can cap job size for a guarded launch.

On top of the unit tests, an invariant fuzzer (`test/fuzz.mjs`) runs random
sequences of everything the contracts allow:
- opening jobs, both normally and gasless, and settling and disputing them;
- deposits and withdrawals;
- agent-wallet caps;
- stablecoin freezes and time jumps.

After every step it checks four things:
- no token appeared or vanished;
- the escrow holds exactly the open payments plus what it owes;
- each agent's locked bond equals its open cover;
- the treasury got exactly the recorded fees.

The release campaign ran 10 seeds of 1,000 steps: 10,000 steps and 737 jobs,
with every invariant holding after every step. Most actions succeeded more
than a hundred times. The rarest were a claim after the review window (43), a
collected frozen payout (47), an expired dispute (13) and a completed bond
withdrawal (4); unit tests cover each of those directly. To repeat it (about
20 minutes):

```
FUZZ_FIRST_SEED=2001 FUZZ_SEEDS=10 FUZZ_STEPS=1000 npm run fuzz
```

## Costs

Measured with `npm run gas`. The totals include each transaction's base cost
and calldata; Base's small L1 data fee is extra.

| Step | Gas |
|---|---:|
| Deploy AgentBond | 1,371,000 |
| Deploy AgentEscrow | 2,905,000 |
| Deploy ERC8183BondHook (optional) | 1,696,000 |
| Approve the escrow as a slasher | 46,000 |
| Agent: approve USDC and post a bond | 123,000 |
| Buyer: approve USDC and open a job (two transactions) | 196,000 |
| Anyone: open a job with the buyer's USDC authorisation (one transaction; the buyer pays nothing) | 182,000 |
| Agent: submit the result | 29,000 |
| Buyer: release payment | 100,000 |
| Anyone: refund a late job and slash its cover | 64,000 |
| Buyer: dispute | 27,000 |
| Arbiter: resolve a dispute | 87,000 |

The core deployment (bond, escrow, slasher approval) is about 4.3M gas:
0.000043 ETH at 0.01 gwei, 0.00043 ETH at 0.1 gwei. A delivered job is about
325k gas: at 0.01–0.1 gwei and $3,000–5,000 per ETH, roughly 1 to 16 cents.
That is several times a plain x402 transfer, so bonded delivery suits jobs worth
a dollar or more. Tiny per-call payments should stay on plain x402.

## Deploy to a test network

```
npm run build
PRIVATE_KEY=0x... UNBONDING_SECONDS=3600 node scripts/deploy.mjs
# after the one-hour slasher delay:
OWNER_KEY=0x... BUYER_KEY=0x... AGENT_ID=... node scripts/smoke.mjs
```

- **Network:** Base Sepolia is the default; `CHAIN=base` selects mainnet,
  which you shouldn't use yet.
- **Addresses:** the deploy script fills in Circle's USDC and the ERC-8004
  IdentityRegistry for the network, and records what it deploys in
  `deployments/<network>.json`.
- **Ownership:** both contracts start owned by the deployer, which configures
  them, then hands them to `OWNER` if set.
- **Other settings:** `ARBITER`, `TREASURY`, `FEE_BPS`, `MAX_JOB_USD` (mainnet
  defaults to $100) and `SANCTIONS_LIST` are optional.
- **Before the smoke run:** register the agent with any ERC-8004 tool, and fund
  both keys with Base Sepolia ETH and test USDC from <https://faucet.circle.com>.
  Use throwaway keys only.
- **Tested end to end:** `test/deploy.test.mjs` runs the whole sequence against
  the in-process chain with signed transactions.

## Roadmap

- A test-network deployment with a public dashboard of jobs, volume and fees.
- An external audit, then a bug bounty, then a guarded mainnet launch with job
  caps and a multisig owner.
- Propose the ERC-8183 hook upstream. It now passes against the reference
  implementation, including its signed-authorization variant.
- Support x402's proposed `job-escrow` scheme, once its wire format is
  settled. It builds on the reference's signed authorizations.
- Optimistic disputes: the buyer's claim stands unless the provider posts a
  counter-bond, with AI-drafted rulings people can appeal. The design must
  follow [these rules](docs/optimistic-disputes.md).
- ERC-8004 feedback that other contracts can read: the escrow records each
  job's outcome, and a separate reporter contract lets anyone post one
  feedback entry per delivered or late job, under the reporter's address. The
  registry stays out of the payment path, and every entry is backed by a paid
  job.
- Quotes that require a proof of the work (TEE attestation or zkML).
- Reputation propagated through the payment graph from verified buyers
  (TraceRank-style).
- Medusa campaigns and Certora rules for the invariants above.

## Limits

- **Not audited.**
- **The arbiter is trusted** for disputed jobs, up to each job's cover. Late
  jobs need no arbiter.
- **The owner can change** the arbiter, the treasury, the fee (up to 1%) and the
  job cap. Adding an escrow or hook is delayed by the unbonding period.
- **Quality is judged off-chain.** The contracts know whether work was
  submitted on time, not whether it is good.
- **The ERC-8004 registry is a dependency.** It is upgradeable, and Arrha trusts
  it to say who owns an agent and which wallet it runs on.
- **For bonded ERC-8183 jobs, the core's admin is trusted.** A pause that
  spans a job's `deliverBy` can get an on-time provider slashed. A hook that
  the admin detaches before funding leaves the job without cover. See
  [the hook's docs](docs/erc-8183-hook.md#what-the-hook-trusts-the-core-for).
- **An agent wallet's key can spend its agent's free bond** up to the owner's
  caps, by signing quotes for fake jobs and letting them run late. Set caps.
- **The risk report and the paywall read events from `fromBlock`** (default
  0). On a real network, pass the escrow's deployment block or use an indexer.
- **x402 facilitators don't know the `arrha` scheme yet.** The buyer, or a
  relayer it picks, sends the transaction that opens the job.
- **The paywall keeps its issued quotes in memory.** After a restart, or
  behind a load balancer, a paid request can reach a process that never issued
  its quote. That job is refused and runs late, so the provider loses the
  cover. Run one paywall process per agent for now.
- **Policies are only as good as their data.**
- **Fuzzing is not proof.** It raises confidence; it replaces neither an audit
  nor formal verification.
- **Not yet run on a live network.** The scripts are tested against the
  in-process EVM with signed transactions.
- **One `npm audit` warning, harmless here.** It flags `tmp`, which only solc's
  command-line tool uses. The build calls solc's compile API, so `tmp` never
  runs.

## Files

| Path | What |
|---|---|
| `contracts/AgentBond.sol` | Bonds keyed by ERC-8004 agent ID; per-slasher locks; unbonding; agent-wallet caps |
| `contracts/AgentEscrow.sol` | Signed quotes, escrow, gasless opening, deadline slashing, disputes, fees, freeze-safe payouts |
| `contracts/ERC8183BondHook.sol` | Provider bonds for ERC-8183 jobs ([docs](docs/erc-8183-hook.md)) |
| `contracts/IAccountPolicy.sol`, `contracts/SanctionsPolicy.sol` | Opt-in compliance checks |
| `contracts/mocks/` | Test stand-ins: USDC with freezes and EIP-3009, ERC-8004 registries, a sanctions list, a minimal ERC-8183, and the ERC-8183 reference implementation (vendored unmodified, MIT) with its proxy |
| `sdk/arrha.mjs` | viem SDK: quotes, x402 extension, trust and policy checks, opening jobs (normal or gasless) |
| `sdk/risk.mjs` | The risk model |
| `sdk/erc8183.mjs` | Cover terms and selectors for ERC-8183 |
| `sdk/x402.mjs` | x402 paywall for providers and fetch wrapper for buyers |
| `test/` | 92 tests, the fuzzer, and the in-process chain |
| `scripts/` | Build, demo, deploy, smoke run, fuzz campaigns, gas table |

## License

[Apache License 2.0](LICENSE). The vendored ERC-8183 reference implementation
in `contracts/mocks/erc8183-reference/` keeps its MIT license (see
[NOTICE](NOTICE)). Contributions are welcome: see
[CONTRIBUTING.md](CONTRIBUTING.md).

*Research software. Not financial, legal or investment advice.*
