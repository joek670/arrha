// Invariant fuzzer: random sequences of everything the contracts allow
// (opening, settling and disputing jobs, bond deposits and withdrawals,
// stablecoin freezes, time jumps), checking after every step that no money
// appeared or vanished and that the bond accounting still adds up.
// Most random calls revert; that's expected. A broken invariant throws.
import { parseUnits } from 'viem';
import { createChain, deployAll, write, read, CHAIN_ID } from './chain.mjs';
import { newQuote, signQuote, openJob, openJobWithAuthorization, signOpenAuthorization, termsHash } from '../sdk/arrha.mjs';

const usd = (n) => parseUnits(String(n), 6);
const tx = { gas: 30_000_000n, gasPrice: 0n };
const DAY = 86400;
const [OPEN, SUBMITTED, DISPUTED, SETTLED] = [1, 2, 3, 4];
const ACTIVE = new Set([OPEN, SUBMITTED, DISPUTED]);

/// mulberry32: small, fast, and the same sequence for the same seed.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function fuzz({ seed = 1, steps = 200 } = {}) {
  const rand = random(seed);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const chain = await createChain();
  const sys = await deployAll(chain, { registry: 'MockAgentRegistry', feeBps: 50 });
  const owners = [chain.wallet(10), chain.wallet(11)];
  const hot = chain.wallet(12); // agent 2 runs on an ERC-8004 agent wallet
  const buyers = [chain.wallet(20), chain.wallet(21), chain.wallet(22)];
  const stranger = chain.wallet(30);
  const everyone = [...owners, hot, ...buyers, stranger, sys.admin, sys.arbiter, sys.treasury];
  const freezable = [...owners, hot, ...buyers, sys.treasury];
  const agents = [1n, 2n];
  const actsFor = { 1: [owners[0]], 2: [owners[1], hot] };
  const ownerOf = { 1: owners[0], 2: owners[1] };

  const call = (who, address, name, fn, args) => write(chain, who, address, name, fn, args);
  for (const o of owners) await call(o, sys.registry, 'MockAgentRegistry', 'register', []);
  await call(owners[1], sys.registry, 'MockAgentRegistry', 'setAgentWallet', [2n, hot.address]);
  for (const w of everyone) await call(w, sys.usdc, 'MockUSDC', 'mint', [w.address, usd(10_000)]);
  for (const [i, o] of owners.entries()) {
    await call(o, sys.usdc, 'MockUSDC', 'approve', [sys.bond, usd(1_000_000)]);
    await call(o, sys.bond, 'AgentBond', 'deposit', [BigInt(i + 1), usd(200)]);
  }

  const supply = await read(chain, sys.usdc, 'MockUSDC', 'totalSupply');
  const treasuryStart = await read(chain, sys.usdc, 'MockUSDC', 'balanceOf', [sys.treasury.address]);
  const jobCount = () => read(chain, sys.escrow, 'AgentEscrow', 'jobCount');
  // Job statuses as of the last invariant check, which runs after every step.
  const statusOf = new Map();
  // Mostly a job in one of `statuses`, so actions reach the paths they test;
  // sometimes any job at all, to exercise the reverts too.
  const someJob = async (...statuses) => {
    const fitting = [...statusOf].filter(([, st]) => statuses.includes(st)).map(([id]) => id);
    if (fitting.length && rand() < 0.85) return BigInt(pick(fitting));
    return BigInt(int(1, Math.max(1, Number(await jobCount()))));
  };
  const jobOf = async (id) => {
    const [buyer, , , status, amount, bondCover, , agentId] = await read(chain, sys.escrow, 'AgentEscrow', 'jobs', [id]);
    return { buyer, status, agentId, amount, bondCover };
  };
  const walletFor = (address) => everyone.find((w) => w.address === address) ?? stranger;

  // A random quote, signed by someone who acts for the agent (or, now and
  // then, by a stranger).
  async function randomQuote() {
    const agentId = pick(agents);
    const signer = rand() < 0.9 ? pick(actsFor[agentId]) : stranger;
    const quote = newQuote({
      agentId,
      amount: usd(int(1, 60)),
      bondCover: usd(int(0, 40)),
      deadline: chain.now() + int(600, 2 * DAY),
      expiry: chain.now() + 600,
      terms: termsHash({ n: int(0, 1e9) }),
    });
    return { quote, signature: await signQuote(signer.account, { chainId: CHAIN_ID, escrow: sys.escrow, quote }) };
  }

  const actions = {
    open: [4, async () => {
      const { quote, signature } = await randomQuote();
      await openJob({ walletClient: pick(buyers).client, publicClient: chain.publicClient, escrow: sys.escrow, paymentToken: sys.usdc, quote, signature, txOptions: tx });
    }],
    // The buyer signs a USDC authorisation; a stranger relays it.
    openGasless: [2, async () => {
      const { quote, signature } = await randomQuote();
      const authorization = await signOpenAuthorization(pick(buyers).account, {
        publicClient: chain.publicClient,
        paymentToken: sys.usdc,
        escrow: sys.escrow,
        quote,
        validBefore: BigInt(chain.now() + int(-60, 3600)),
      });
      await openJobWithAuthorization({ walletClient: stranger.client, publicClient: chain.publicClient, escrow: sys.escrow, quote, signature, authorization, txOptions: tx });
    }],
    // Agent 2's owner caps (or uncaps) what its hot wallet may commit.
    walletLimits: [1, async () =>
      call(owners[1], sys.bond, 'AgentBond', 'setWalletLimits', [2n, usd(int(0, 40)), usd(int(0, 80)), rand() < 0.5])],
    submit: [3, async () => {
      const id = await someJob(OPEN);
      const { agentId } = await jobOf(id);
      const who = rand() < 0.9 && agentId > 0n ? pick(actsFor[agentId]) : stranger;
      await call(who, sys.escrow, 'AgentEscrow', 'submit', [id, termsHash({ id: String(id) })]);
    }],
    release: [2, async () => {
      const id = await someJob(OPEN, SUBMITTED);
      const { buyer } = await jobOf(id);
      await call(rand() < 0.9 ? walletFor(buyer) : stranger, sys.escrow, 'AgentEscrow', 'release', [id]);
    }],
    claim: [2, async () => call(stranger, sys.escrow, 'AgentEscrow', 'claim', [await someJob(SUBMITTED)])],
    refundLate: [2, async () => call(stranger, sys.escrow, 'AgentEscrow', 'refundLate', [await someJob(OPEN)])],
    dispute: [2, async () => {
      const id = await someJob(SUBMITTED);
      const { buyer } = await jobOf(id);
      await call(walletFor(buyer), sys.escrow, 'AgentEscrow', 'dispute', [id]);
    }],
    resolve: [2, async () =>
      call(sys.arbiter, sys.escrow, 'AgentEscrow', 'resolve', [await someJob(DISPUTED), int(0, 10_000), usd(int(0, 50))])],
    expireDispute: [1, async () => call(stranger, sys.escrow, 'AgentEscrow', 'expireDispute', [await someJob(DISPUTED)])],
    withdrawOwed: [2, async () => call(pick(everyone), sys.escrow, 'AgentEscrow', 'withdrawOwed', [sys.usdc])],
    deposit: [1, async () => {
      const agentId = pick(agents);
      await call(ownerOf[agentId], sys.bond, 'AgentBond', 'deposit', [agentId, usd(int(1, 50))]);
    }],
    requestWithdrawal: [1, async () => {
      const agentId = pick(agents);
      await call(ownerOf[agentId], sys.bond, 'AgentBond', 'requestWithdrawal', [agentId, usd(int(1, 120))]);
    }],
    cancelWithdrawal: [1, async () => {
      const agentId = pick(agents);
      await call(ownerOf[agentId], sys.bond, 'AgentBond', 'cancelWithdrawal', [agentId]);
    }],
    withdraw: [1, async () => {
      const agentId = pick(agents);
      await call(ownerOf[agentId], sys.bond, 'AgentBond', 'withdraw', [agentId]);
    }],
    freeze: [1, async () => {
      const who = pick(freezable).address;
      const frozen = await read(chain, sys.usdc, 'MockUSDC', 'frozen', [who]);
      await call(sys.admin, sys.usdc, 'MockUSDC', 'setFrozen', [who, !frozen]);
    }],
    // Mostly short hops, so review and dispute windows are often still open;
    // now and then long enough for an absent arbiter or a bond to unbond.
    advance: [3, async () => {
      const r = rand();
      chain.advance(r < 0.7 ? int(0, DAY / 6) : r < 0.9 ? int(0, 2 * DAY) : int(3 * DAY, 8 * DAY));
    }],
  };
  const deck = Object.entries(actions).flatMap(([name, [weight]]) => Array(weight).fill(name));

  const settled = new Set();
  const stats = { steps: 0, succeeded: 0, reverted: 0, byAction: {} };

  async function checkInvariants(step, action) {
    const fail = (what) => {
      throw new Error(`invariant broken after step ${step} (${action}), seed ${seed}: ${what}`);
    };
    const balance = (a) => read(chain, sys.usdc, 'MockUSDC', 'balanceOf', [a]);
    const owed = (a) => read(chain, sys.escrow, 'AgentEscrow', 'owed', [sys.usdc, a]);

    // Every token is somewhere we know about: nothing minted, nothing lost.
    let held = (await balance(sys.escrow)) + (await balance(sys.bond));
    let owedTotal = 0n;
    for (const w of everyone) {
      held += await balance(w.address);
      owedTotal += await owed(w.address);
    }
    if (held !== supply) fail(`tokens held ${held} != supply ${supply}`);

    // The escrow holds exactly the open jobs' payments plus what it owes.
    let escrowed = 0n;
    const cover = { 1: 0n, 2: 0n };
    const count = Number(await jobCount());
    for (let id = 1; id <= count; id++) {
      const job = await jobOf(BigInt(id));
      statusOf.set(id, job.status);
      if (settled.has(id) && job.status !== SETTLED) fail(`job ${id} left the settled state`);
      if (job.status === SETTLED) settled.add(id);
      if (ACTIVE.has(job.status)) {
        escrowed += job.amount;
        cover[job.agentId] += job.bondCover;
      }
    }
    const escrowBalance = await balance(sys.escrow);
    if (escrowBalance !== escrowed + owedTotal) fail(`escrow holds ${escrowBalance}, owes ${escrowed} + ${owedTotal}`);

    // The bond contract holds exactly the agents' bonds, and each agent's
    // locked bond is exactly the cover of its open jobs.
    let bonded = 0n;
    for (const agentId of agents) {
      const [total, locked, pending] = await read(chain, sys.bond, 'AgentBond', 'bonds', [agentId]);
      bonded += total;
      if (locked + pending > total) fail(`agent ${agentId}: locked ${locked} + pending ${pending} > total ${total}`);
      if (locked !== cover[agentId]) fail(`agent ${agentId}: locked ${locked} != open cover ${cover[agentId]}`);
      const byEscrow = await read(chain, sys.bond, 'AgentBond', 'lockedBy', [agentId, sys.escrow]);
      if (byEscrow !== locked) fail(`agent ${agentId}: lockedBy ${byEscrow} != locked ${locked}`);
    }
    const bondBalance = await balance(sys.bond);
    if (bondBalance !== bonded) fail(`bond contract holds ${bondBalance}, bonds total ${bonded}`);

    // The treasury has received, or is owed, exactly the fees recorded.
    const fees = await read(chain, sys.escrow, 'AgentEscrow', 'totalFees');
    const toTreasury = (await balance(sys.treasury.address)) - treasuryStart + (await owed(sys.treasury.address));
    if (toTreasury !== fees) fail(`treasury got ${toTreasury}, totalFees says ${fees}`);
  }

  await checkInvariants(0, 'setup');
  for (let step = 1; step <= steps; step++) {
    const action = pick(deck);
    const s = (stats.byAction[action] ??= { ok: 0, reverted: 0 });
    try {
      await actions[action][1]();
      stats.succeeded += 1;
      s.ok += 1;
    } catch (err) {
      if (!/revert/i.test(err.message)) throw err; // a harness bug, not a contract revert
      stats.reverted += 1;
      s.reverted += 1;
    }
    stats.steps = step;
    await checkInvariants(step, action);
  }
  stats.jobs = Number(await jobCount());
  stats.settledJobs = settled.size;
  return stats;
}
