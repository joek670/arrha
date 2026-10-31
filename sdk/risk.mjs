// Agent risk report: a score for a provider agent built only from its paid,
// settled jobs in AgentEscrow and its bond in AgentBond.
//
// Why settled jobs and not feedback: an empirical study of ERC-8004 found
// that most reviewers leave coordinated Sybil feedback and that feedback is
// rarely tied to a real interaction. Here every data point is a payment that
// went through escrow, so faking a record costs real money in fees.
//
// The model is the one recent agent-reputation work converges on:
// - a Beta estimate of the chance the agent delivers, starting from a neutral
//   prior, so a thin record reads as "unknown", not "trusted";
// - exponential decay, so old jobs count less than recent ones;
// - log-scaled job size, so big jobs count more, but not proportionally;
// - repeat jobs from the same buyer counting 1/2, 1/3, 1/4..., so one buyer,
//   or one operator buying from itself, can't build a record alone.
// The score is the 90% lower bound of the estimate, then the capital flags
// below. Every number in the report traces to on-chain events, and every
// deduction says why, so anyone can check a score and see what moves it.
import { formatUnits, parseAbi } from 'viem';
import { bondAbi } from './arrha.mjs';

const escrowEvents = parseAbi([
  'event JobOpened(uint256 indexed jobId, uint256 indexed agentId, address indexed buyer, uint256 amount, uint256 bondCover, bytes32 terms)',
  'event JobSettled(uint256 indexed jobId, uint256 indexed agentId, uint8 outcome, uint256 toProvider, uint256 toBuyer, uint256 slashed, uint256 fee)',
]);

/// AgentEscrow.Outcome, in declaration order.
export const OUTCOMES = ['released', 'claimed', 'late', 'arbitrated', 'arbiterTimedOut'];

/// The model's settings. Starting points, to tune once real data exists.
export const MODEL = {
  prior: [2, 2], // Beta(2, 2): no record reads as a coin flip
  halfLifeDays: 90, // a job's weight halves every 90 days
  referenceJobUsd: 10, // a $10 job counts as one job
  z: 1.2816, // one-sided 90% lower bound
};

/// Score bands: 80 and up is low risk, 50 to 79 medium, below 50 high.
/// An agent with no jobs yet is "unproven": only its bond speaks for it.
export function band(score, jobs) {
  if (jobs === 0) return 'unproven';
  return score >= 80 ? 'low' : score >= 50 ? 'medium' : 'high';
}

/// How much one settled job says about delivery: [delivered, failed].
/// Late or slashed is a failure. A ruling splits by the share the provider
/// kept. A dispute the arbiter never ruled on says nothing either way.
export function outcomeEvidence({ outcome, toProvider, toBuyer, slashed }) {
  switch (OUTCOMES[outcome]) {
    case 'released':
    case 'claimed':
      return [1, 0];
    case 'late':
      return [0, 1];
    case 'arbitrated': {
      if (slashed > 0n) return [0, 1];
      const total = toProvider + toBuyer;
      const kept = total > 0n ? Number((toProvider * 10_000n) / total) / 10_000 : 0;
      return [kept, 1 - kept];
    }
    default:
      return [0, 0];
  }
}

/// Mean and lower bound of Beta(a, b), using the normal approximation.
export function betaSummary(a, b, z = MODEL.z) {
  const mean = a / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  return { mean, lower: Math.max(0, mean - z * sd) };
}

export async function agentRiskReport(publicClient, { escrow, bond, agentId, fromBlock = 0n, decimals = 6, model = MODEL }) {
  agentId = BigInt(agentId);
  const money = (n) => `$${formatUnits(n, decimals)}`;
  const events = (eventName) =>
    publicClient.getContractEvents({ address: escrow, abi: escrowEvents, eventName, args: { agentId }, fromBlock, toBlock: 'latest' });

  const opened = await events('JobOpened');
  const settled = await events('JobSettled');
  const [total, locked, pending] = await publicClient.readContract({ address: bond, abi: bondAbi, functionName: 'bonds', args: [agentId] });
  const free = total - locked - pending;
  const now = Number((await publicClient.getBlock()).timestamp);

  const jobsById = new Map(opened.map((log) => [log.args.jobId, log.args]));
  const blockTime = new Map();
  const timeOf = async (blockNumber) => {
    if (!blockTime.has(blockNumber)) blockTime.set(blockNumber, Number((await publicClient.getBlock({ blockNumber })).timestamp));
    return blockTime.get(blockNumber);
  };

  // Settled jobs, oldest first, so repeat-buyer weights follow the order jobs happened.
  const ordered = [...settled].sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : Number(x.blockNumber - y.blockNumber)));
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const repeats = new Map();
  let [a, b] = model.prior;
  let evidence = 0;
  let slashed = 0n;
  let disputesLost = 0;
  for (const log of ordered) {
    const { args } = log;
    const outcome = OUTCOMES[args.outcome];
    outcomes[outcome] += 1;
    slashed += args.slashed;
    if (outcome === 'arbitrated' && args.slashed > 0n) disputesLost += 1;

    const job = jobsById.get(args.jobId);
    const buyer = job?.buyer ?? 'unknown';
    const nth = (repeats.get(buyer) ?? 0) + 1;
    repeats.set(buyer, nth);
    const ageDays = Math.max(0, now - (await timeOf(log.blockNumber))) / 86_400;
    const usdAmount = Number(formatUnits(job?.amount ?? 0n, decimals));
    const weight = 0.5 ** (ageDays / model.halfLifeDays) * (Math.log1p(usdAmount) / Math.log1p(model.referenceJobUsd)) * (1 / nth);

    const [delivered, failed] = outcomeEvidence(args);
    a += weight * delivered;
    b += weight * failed;
    if (delivered + failed > 0) evidence += weight;
  }
  const delivery = { ...betaSummary(a, b, model.z), evidence };

  let volume = 0n;
  const volumeByBuyer = new Map();
  for (const { args } of opened) {
    volume += args.amount;
    volumeByBuyer.set(args.buyer, (volumeByBuyer.get(args.buyer) ?? 0n) + args.amount);
  }
  const topBuyerVolume = [...volumeByBuyer.values()].reduce((x, y) => (y > x ? y : x), 0n);
  const jobs = opened.length;
  const metrics = {
    jobs,
    settled: settled.length,
    open: jobs - settled.length,
    outcomes,
    disputesLost,
    volume,
    slashed,
    distinctBuyers: volumeByBuyer.size,
    topBuyerShareBps: volume > 0n ? Number((topBuyerVolume * 10_000n) / volume) : 0,
    averageJob: jobs ? volume / BigInt(jobs) : 0n,
    bond: { total, locked, pending, free },
  };

  const pct = (x) => `${Math.round(x * 100)}%`;
  const explanation = [];
  if (settled.length) {
    const failedJobs = outcomes.late + disputesLost;
    explanation.push(
      `${outcomes.released + outcomes.claimed} delivered, ${outcomes.late} late, ${disputesLost} lost dispute(s) out of ${settled.length} settled job(s)`,
      `counts as ${evidence.toFixed(1)} job(s) once older jobs, small jobs and repeat buyers are weighted down`,
      `on-time delivery estimated at ${pct(delivery.mean)}; at least ${pct(delivery.lower)} with 90% confidence${failedJobs === 0 && delivery.lower < 0.8 ? ' (a longer record raises this)' : ''}`,
    );
  } else {
    explanation.push('no settled jobs yet: only the bond backs this agent');
  }

  const flags = [];
  const flag = (points, reason) => flags.push({ points, reason });
  if (jobs >= 3 && metrics.topBuyerShareBps > 5_000) {
    flag(-10, `one buyer is ${(metrics.topBuyerShareBps / 100).toFixed(0)}% of volume: a thin or wash-traded record`);
  }
  if (free === 0n) flag(-25, 'no free bond: nothing backs a new job');
  else if (jobs > 0 && free < metrics.averageJob) flag(-15, `free bond ${money(free)} is less than its average job (${money(metrics.averageJob)})`);
  if (pending > 0n) flag(-10, `is withdrawing ${money(pending)} of its bond`);

  const base = Math.round(delivery.lower * 100);
  const score = Math.min(100, Math.max(0, base + flags.reduce((sum, f) => sum + f.points, 0)));
  return { agentId, score, band: band(score, jobs), delivery, explanation, flags, metrics };
}
