import { test } from 'node:test';
import assert from 'node:assert/strict';
import { write } from './chain.mjs';
import { setup, usd, DAY } from './fixture.mjs';
import { termsHash } from '../sdk/arrha.mjs';
import { agentRiskReport, betaSummary, outcomeEvidence } from '../sdk/risk.mjs';

const report = (t) => agentRiskReport(t.chain.publicClient, { escrow: t.sys.escrow, bond: t.sys.bond, agentId: t.agentId });

async function buyers(t, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = t.chain.wallet(40 + i);
    await write(t.chain, w, t.sys.usdc, 'MockUSDC', 'mint', [w.address, usd(500)]);
    out.push(w);
  }
  return out;
}

async function deliver(t, buyer, over) {
  const jobId = await t.open(t.quote(over), undefined, buyer);
  await write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({ jobId: String(jobId) })]);
  await write(t.chain, buyer, t.sys.escrow, 'AgentEscrow', 'release', [jobId]);
}

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('the model: Beta(2, 2) prior, normal-approximation lower bound, evidence per outcome', () => {
  // With no evidence the estimate is a coin flip with wide uncertainty.
  const prior = betaSummary(2, 2);
  close(prior.mean, 0.5);
  close(prior.lower, 0.5 - 1.2816 * Math.sqrt(4 / (16 * 5)));
  assert.deepEqual(outcomeEvidence({ outcome: 0, toProvider: 1n, toBuyer: 0n, slashed: 0n }), [1, 0]);
  assert.deepEqual(outcomeEvidence({ outcome: 2, toProvider: 0n, toBuyer: 1n, slashed: 1n }), [0, 1]);
  assert.deepEqual(outcomeEvidence({ outcome: 3, toProvider: 75n, toBuyer: 25n, slashed: 0n }), [0.75, 0.25]);
  assert.deepEqual(outcomeEvidence({ outcome: 3, toProvider: 75n, toBuyer: 25n, slashed: 5n }), [0, 1]);
  assert.deepEqual(outcomeEvidence({ outcome: 4, toProvider: 0n, toBuyer: 10n, slashed: 0n }), [0, 0]);
});

test('a new bonded agent is unproven, and an unbonded one is flagged', async () => {
  const fresh = await report(await setup());
  assert.equal(fresh.band, 'unproven');
  assert.deepEqual(fresh.flags, []);
  assert.match(fresh.explanation[0], /no settled jobs yet/);
  const bare = await report(await setup({ bond: 0 }));
  assert.equal(bare.band, 'unproven');
  assert.match(bare.flags[0].reason, /no free bond/);
});

test('a short record stays modest; a long one with many buyers scores low risk', async () => {
  const t = await setup({ bond: 200 });
  const many = await buyers(t, 16);
  for (const b of many.slice(0, 4)) await deliver(t, b);
  const short = await report(t);
  // Four $10 jobs from four buyers: Beta(6, 2).
  close(short.delivery.mean, 0.75);
  assert.equal(short.score, Math.round(betaSummary(6, 2).lower * 100));
  assert.equal(short.band, 'medium');
  assert.match(short.explanation[2], /a longer record raises this/);

  for (const b of many.slice(4)) await deliver(t, b);
  const long = await report(t);
  assert.equal(long.band, 'low');
  assert.equal(long.score, Math.round(betaSummary(18, 2).lower * 100));
  assert.equal(long.metrics.distinctBuyers, 16);
});

test('late jobs and lost disputes pull the estimate down, with the reasons spelled out', async () => {
  const t = await setup({ bond: 200 });
  const [a, b, c, d] = await buyers(t, 4);
  await deliver(t, a);
  await deliver(t, b);

  const late = await t.open(t.quote(), undefined, c);
  t.chain.advance(DAY + 1);
  await write(t.chain, c, t.sys.escrow, 'AgentEscrow', 'refundLate', [late]);

  const contested = await t.open(t.quote(), undefined, d);
  await write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [contested, termsHash({})]);
  await write(t.chain, d, t.sys.escrow, 'AgentEscrow', 'dispute', [contested]);
  await write(t.chain, t.sys.arbiter, t.sys.escrow, 'AgentEscrow', 'resolve', [contested, 10_000, usd(10)]);

  const r = await report(t);
  // Two delivered, two failed, all from different buyers and about a day apart.
  close(r.delivery.mean, 0.5, 0.01);
  assert.equal(r.band, 'high');
  assert.match(r.explanation[0], /2 delivered, 1 late, 1 lost dispute\(s\) out of 4/);
  assert.equal(r.metrics.slashed, usd(30));
});

test('repeat jobs from one buyer count less, and the concentration is flagged', async () => {
  const t = await setup();
  const [only] = await buyers(t, 1);
  for (let i = 0; i < 5; i++) await deliver(t, only);
  const r = await report(t);
  close(r.delivery.evidence, 1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5);
  assert.ok(r.flags.some((f) => /wash-traded/.test(f.reason)));
  assert.equal(r.band, 'high');
});

test('old evidence fades: two half-lives later a record counts a quarter as much', async () => {
  const t = await setup();
  for (const b of await buyers(t, 3)) await deliver(t, b);
  const fresh = await report(t);
  close(fresh.delivery.evidence, 3, 1e-3);
  t.chain.advance(180 * DAY);
  const old = await report(t);
  close(old.delivery.evidence, 0.75, 1e-3);
  assert.ok(old.delivery.lower < fresh.delivery.lower);
});

test('an agent pulling its bond out is flagged, and so is bond below its usual job size', async () => {
  const t = await setup({ bond: 50 });
  for (const b of await buyers(t, 3)) await deliver(t, b, { amount: usd(40), bondCover: usd(10) });
  await write(t.chain, t.provider, t.sys.bond, 'AgentBond', 'requestWithdrawal', [t.agentId, usd(20)]);
  const r = await report(t);
  assert.ok(r.flags.some((f) => /is withdrawing \$20/.test(f.reason)));
  assert.ok(r.flags.some((f) => /free bond \$30 is less than its average job \(\$40\)/.test(f.reason)));
});
