// What changes when the money is a regulated stablecoin: issuers can freeze
// addresses, some providers must screen who pays them, and fees have to be
// checkable on-chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploy, write, read } from './chain.mjs';
import { setup, usd, DAY } from './fixture.mjs';
import { checkTrust, termsHash } from '../sdk/arrha.mjs';

const freeze = (t, who, frozen = true) => write(t.chain, t.sys.admin, t.sys.usdc, 'MockUSDC', 'setFrozen', [who, frozen]);
const owed = (t, who) => read(t.chain, t.sys.escrow, 'AgentEscrow', 'owed', [t.sys.usdc, who]);
const escrowCall = (t, who, fn, args) => write(t.chain, who, t.sys.escrow, 'AgentEscrow', fn, args);

test('a frozen buyer cannot block a late-delivery slash; the refund waits for the buyer', async () => {
  const t = await setup();
  const jobId = await t.open(t.quote());
  await freeze(t, t.buyer.address);
  t.chain.advance(DAY + 1);

  // Without the fallback this reverted, and the cover stayed locked for good.
  await escrowCall(t, t.chain.wallet(20), 'refundLate', [jobId]);
  assert.deepEqual(await t.bondOf(), { total: usd(80), locked: 0n, pending: 0n });
  assert.equal(await owed(t, t.buyer.address), usd(30)); // $10 refund + $20 cover

  // Still frozen: the funds don't move, to the buyer or anywhere else.
  await assert.rejects(escrowCall(t, t.buyer, 'withdrawOwed', [t.sys.usdc]), /AccountFrozen/);
  await assert.rejects(escrowCall(t, t.chain.wallet(20), 'withdrawOwed', [t.sys.usdc]), /NothingOwed/);

  await freeze(t, t.buyer.address, false);
  const before = await t.balance(t.buyer.address);
  await escrowCall(t, t.buyer, 'withdrawOwed', [t.sys.usdc]);
  assert.equal((await t.balance(t.buyer.address)) - before, usd(30));
  assert.equal(await owed(t, t.buyer.address), 0n);
});

test('a frozen provider still frees its cover and the fee still reaches the treasury', async () => {
  const t = await setup();
  const jobId = await t.open(t.quote());
  await write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({ done: true })]);
  await freeze(t, t.provider.address);
  await escrowCall(t, t.buyer, 'release', [jobId]);

  assert.equal(await owed(t, t.provider.address), usd(9.95));
  assert.equal(await t.balance(t.sys.treasury.address), usd(0.05));
  assert.equal((await t.bondOf()).locked, 0n);
});

test('a frozen buyer cannot stall a dispute ruling', async () => {
  const t = await setup();
  const jobId = await t.open(t.quote());
  await write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({})]);
  await escrowCall(t, t.buyer, 'dispute', [jobId]);
  await freeze(t, t.buyer.address);
  await escrowCall(t, t.sys.arbiter, 'resolve', [jobId, 10_000, usd(5)]);
  assert.equal(await owed(t, t.buyer.address), usd(15)); // $10 back + $5 slashed
  assert.deepEqual(await t.bondOf(), { total: usd(95), locked: 0n, pending: 0n });
});

test('a provider can require buyers to pass a sanctions screen; checkTrust warns before any gas is spent', async () => {
  const t = await setup();
  const list = await deploy(t.chain, t.sys.admin, 'MockSanctionsList');
  const policy = await deploy(t.chain, t.sys.admin, 'SanctionsPolicy', [list]);
  await write(t.chain, t.sys.admin, list, 'MockSanctionsList', 'set', [t.buyer.address, true]);

  const q = t.quote({ policy });
  const trust = await checkTrust(t.chain.publicClient, { bond: t.sys.bond, quote: q, buyer: t.buyer.address });
  assert.equal(trust.ok, false);
  assert.match(trust.reasons[0], /doesn't pass the provider's policy/);
  await assert.rejects(t.open(q), /PolicyRejected/);

  // A clean buyer gets through the same kind of quote.
  const clean = t.chain.wallet(21);
  await write(t.chain, clean, t.sys.usdc, 'MockUSDC', 'mint', [clean.address, usd(100)]);
  const q2 = t.quote({ policy });
  assert.equal((await checkTrust(t.chain.publicClient, { bond: t.sys.bond, quote: q2, buyer: clean.address })).ok, true);
  assert.equal(await t.open(q2, undefined, clean), 1n);
});

test('a buyer can screen whoever owns the provider agent before paying', async () => {
  const t = await setup();
  const list = await deploy(t.chain, t.sys.admin, 'MockSanctionsList');
  const screen = await deploy(t.chain, t.sys.admin, 'SanctionsPolicy', [list]);
  assert.equal((await checkTrust(t.chain.publicClient, { bond: t.sys.bond, quote: t.quote(), screen })).ok, true);
  await write(t.chain, t.sys.admin, list, 'MockSanctionsList', 'set', [t.provider.address, true]);
  const trust = await checkTrust(t.chain.publicClient, { bond: t.sys.bond, quote: t.quote(), screen });
  assert.equal(trust.ok, false);
  assert.match(trust.reasons[0], /provider owner/);
});

test('an agent cannot hire itself to manufacture reputation', async () => {
  const t = await setup();
  await assert.rejects(t.open(t.quote(), undefined, t.provider), /self-dealing/);
});

test('volume and fee totals are readable on-chain', async () => {
  const t = await setup();
  const a = await t.open(t.quote());
  const b = await t.open(t.quote({ amount: usd(30) }));
  await escrowCall(t, t.buyer, 'release', [a]);
  await escrowCall(t, t.buyer, 'release', [b]);
  await t.open(t.quote({ amount: usd(5), bondCover: 0n })); // still open: counted in volume, no fee yet
  assert.equal(await read(t.chain, t.sys.escrow, 'AgentEscrow', 'totalVolume'), usd(45));
  assert.equal(await read(t.chain, t.sys.escrow, 'AgentEscrow', 'totalFees'), usd(0.2));
  assert.equal(await t.balance(t.sys.treasury.address), usd(0.2));
});
