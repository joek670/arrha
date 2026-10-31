import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zeroAddress } from 'viem';
import { deploy, write, read, CHAIN_ID } from './chain.mjs';
import { setup, usd, DAY, tx } from './fixture.mjs';
import { toX402Extra, fromX402Requirements, checkTrust, openJob, termsHash } from '../sdk/arrha.mjs';

test('x402 round trip: quote travels in the 402 response, buyer checks the bond, opens, releases', async () => {
  const t = await setup();
  const q = t.quote();
  const signature = await t.sign(q);

  // Provider side: what goes into PaymentRequirements.extra, sent as JSON.
  const requirements = JSON.parse(JSON.stringify({
    scheme: 'exact',
    network: 'base-sepolia',
    payTo: t.provider.address,
    extra: toX402Extra({ chainId: CHAIN_ID, escrow: t.sys.escrow, bond: t.sys.bond, quote: q, signature }),
  }));

  // Buyer side.
  const offer = fromX402Requirements(requirements);
  assert.deepEqual(offer.quote, q);
  const trust = await checkTrust(t.chain.publicClient, { bond: offer.bond, quote: offer.quote, minCoverBps: 10_000 });
  assert.equal(trust.ok, true, trust.reasons.join('; '));

  const before = await t.balance(t.provider.address);
  const jobId = await t.open(offer.quote, offer.signature);
  assert.equal(jobId, 1n);
  assert.equal((await t.bondOf()).locked, usd(20));

  await write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({ answer: 42 })]);
  await write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'release', [jobId]);

  assert.equal((await t.balance(t.provider.address)) - before, usd(9.95));
  assert.equal(await t.balance(t.sys.treasury.address), usd(0.05));
  assert.deepEqual(await t.bondOf(), { total: usd(100), locked: 0n, pending: 0n });
});

test('fromX402Requirements ignores requirements without an Arrha offer', () => {
  assert.equal(fromX402Requirements({ scheme: 'exact', extra: { name: 'USDC' } }), null);
  assert.equal(fromX402Requirements(undefined), null);
});

test('anyone can claim for the provider once the review window passes', async () => {
  const t = await setup();
  const jobId = await t.open(t.quote());
  await write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({ ok: true })]);
  const stranger = t.chain.wallet(20);
  await assert.rejects(write(t.chain, stranger, t.sys.escrow, 'AgentEscrow', 'claim', [jobId]), /TooEarly/);
  t.chain.advance(DAY + 1);
  await write(t.chain, stranger, t.sys.escrow, 'AgentEscrow', 'claim', [jobId]);
  assert.equal((await t.bondOf()).locked, 0n);
  await assert.rejects(write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'dispute', [jobId]), /WrongStatus/);
});

test('a missed deadline refunds the buyer and slashes the full cover, no arbiter needed', async () => {
  const t = await setup();
  const start = await t.balance(t.buyer.address);
  const jobId = await t.open(t.quote());
  await assert.rejects(write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'refundLate', [jobId]), /TooEarly/);
  t.chain.advance(DAY + 1);
  await assert.rejects(write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({})]), /TooLate/);
  await write(t.chain, t.chain.wallet(20), t.sys.escrow, 'AgentEscrow', 'refundLate', [jobId]);
  assert.equal((await t.balance(t.buyer.address)) - start, usd(20));
  assert.deepEqual(await t.bondOf(), { total: usd(80), locked: 0n, pending: 0n });
});

test('the arbiter splits a disputed payment and slashes part of the cover', async () => {
  const t = await setup();
  const start = { buyer: await t.balance(t.buyer.address), provider: await t.balance(t.provider.address) };
  const jobId = await t.open(t.quote());
  await write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({ bad: true })]);
  await write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'dispute', [jobId]);
  await assert.rejects(write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'resolve', [jobId, 10_000, usd(20)]), /NotArbiter/);
  await write(t.chain, t.sys.arbiter, t.sys.escrow, 'AgentEscrow', 'resolve', [jobId, 5_000, usd(5)]);

  // Buyer: -10 paid, +5 refund, +5 slashed. Provider: +5 less 0.5% fee.
  assert.equal((await t.balance(t.buyer.address)) - start.buyer, 0n);
  assert.equal((await t.balance(t.provider.address)) - start.provider, usd(4.975));
  assert.equal(await t.balance(t.sys.treasury.address), usd(0.025));
  assert.deepEqual(await t.bondOf(), { total: usd(95), locked: 0n, pending: 0n });
});

test('the arbiter can never slash more than the cover the provider signed for', async () => {
  const t = await setup();
  const jobId = await t.open(t.quote());
  await write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({})]);
  await write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'dispute', [jobId]);
  await write(t.chain, t.sys.arbiter, t.sys.escrow, 'AgentEscrow', 'resolve', [jobId, 10_000, usd(100)]);
  assert.deepEqual(await t.bondOf(), { total: usd(80), locked: 0n, pending: 0n });
});

test('a dispute the arbiter ignores refunds the buyer and frees the cover', async () => {
  const t = await setup();
  const start = await t.balance(t.buyer.address);
  const jobId = await t.open(t.quote());
  await write(t.chain, t.provider, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({})]);
  t.chain.advance(DAY - 10);
  await write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'dispute', [jobId]);
  t.chain.advance(3 * DAY);
  await assert.rejects(write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'expireDispute', [jobId]), /TooEarly/);
  t.chain.advance(1);
  await write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'expireDispute', [jobId]);
  assert.equal(await t.balance(t.buyer.address), start);
  assert.deepEqual(await t.bondOf(), { total: usd(100), locked: 0n, pending: 0n });
});

test('quotes cannot be replayed, forged, redirected or used late', async () => {
  const t = await setup();
  const q = t.quote();
  const sig = await t.sign(q);
  await t.open(q, sig);
  await assert.rejects(t.open(q, sig), /used/);

  const stranger = t.chain.wallet(20);
  await assert.rejects(t.open(t.quote(), await t.sign(t.quote(), stranger.account)), /BadSignature/);

  const tampered = t.quote();
  const tamperedSig = await t.sign(tampered);
  await assert.rejects(t.open({ ...tampered, amount: usd(1) }, tamperedSig), /BadSignature/);

  const forOtherEscrow = t.quote();
  await assert.rejects(t.open(forOtherEscrow, await t.sign(forOtherEscrow, t.provider.account, t.sys.bond)), /BadSignature/);

  const private_ = t.quote({ buyer: t.buyer.address });
  await assert.rejects(t.open(private_, await t.sign(private_), stranger), /buyer/);

  const stale = t.quote();
  const staleSig = await t.sign(stale);
  t.chain.advance(601);
  await assert.rejects(t.open(stale, staleSig), /expired/);
});

test('a quote cannot promise more cover than the agent has free, and checkTrust says so', async () => {
  const t = await setup({ bond: 15 });
  const q = t.quote();
  const trust = await checkTrust(t.chain.publicClient, { bond: t.sys.bond, quote: q });
  assert.equal(trust.ok, false);
  assert.match(trust.reasons[0], /free bond/);
  await assert.rejects(t.open(q), /InsufficientFreeBond/);

  const weak = await checkTrust(t.chain.publicClient, { bond: t.sys.bond, quote: t.quote({ bondCover: usd(5) }), minCoverBps: 10_000 });
  assert.equal(weak.ok, false);
  assert.match(weak.reasons[0], /below/);
});

test('bond withdrawals wait out the unbonding period and never touch locked bond', async () => {
  const t = await setup();
  const call = (who, fn, args) => write(t.chain, who, t.sys.bond, 'AgentBond', fn, args);
  await t.open(t.quote()); // locks 20

  await assert.rejects(call(t.buyer, 'requestWithdrawal', [t.agentId, usd(10)]), /NotAgentOwner/);
  await assert.rejects(call(t.provider, 'requestWithdrawal', [t.agentId, usd(81)]), /InsufficientFreeBond/);
  await call(t.provider, 'requestWithdrawal', [t.agentId, usd(80)]);

  // Pending bond can't back new jobs.
  await assert.rejects(t.open(t.quote({ bondCover: usd(1) })), /InsufficientFreeBond/);

  await assert.rejects(call(t.provider, 'withdraw', [t.agentId]), /StillUnbonding/);
  t.chain.advance(7 * DAY);
  const before = await t.balance(t.provider.address);
  await call(t.provider, 'withdraw', [t.agentId]);
  assert.equal((await t.balance(t.provider.address)) - before, usd(80));
  assert.deepEqual(await t.bondOf(), { total: usd(20), locked: usd(20), pending: 0n });
});

test('a new slasher waits a full unbonding period, and each slasher only touches its own locks', async () => {
  const t = await setup();
  const { admin, arbiter, treasury } = t.sys;
  const rogue = await deploy(t.chain, admin, 'AgentEscrow', [t.sys.usdc, t.sys.bond, BigInt(DAY), BigInt(DAY), arbiter.address, treasury.address, 0, admin.address]);
  await write(t.chain, admin, t.sys.bond, 'AgentBond', 'proposeSlasher', [rogue]);

  const q = t.quote();
  const sig = await t.sign(q, t.provider.account, rogue);
  const openRogue = () => openJob({ walletClient: t.buyer.client, publicClient: t.chain.publicClient, escrow: rogue, paymentToken: t.sys.usdc, quote: q, signature: sig, txOptions: tx });
  await assert.rejects(openRogue(), /NotSlasher/);

  // The real escrow locks 20; a direct slash from anyone else finds nothing to take.
  await t.open(t.quote());
  await assert.rejects(write(t.chain, t.buyer, t.sys.bond, 'AgentBond', 'slash', [t.agentId, usd(20), t.buyer.address]), /InsufficientLockedBond/);
  t.chain.advance(7 * DAY);
  assert.equal(await read(t.chain, t.sys.bond, 'AgentBond', 'isSlasher', [rogue]), true);
  await assert.rejects(write(t.chain, t.buyer, t.sys.bond, 'AgentBond', 'slash', [t.agentId, 1n, t.buyer.address]), /InsufficientLockedBond/);
});

test('retiring an escrow blocks new jobs but its open jobs still settle', async () => {
  const t = await setup();
  const jobId = await t.open(t.quote());
  await write(t.chain, t.sys.admin, t.sys.bond, 'AgentBond', 'retireSlasher', [t.sys.escrow]);
  await assert.rejects(t.open(t.quote()), /NotSlasher/);
  await write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'release', [jobId]);
  assert.equal((await t.bondOf()).locked, 0n);
});

test('fees are capped at 1%, fixed per job when it opens, and never sent to 0x0', async () => {
  const t = await setup();
  const setFee = (bps) => write(t.chain, t.sys.admin, t.sys.escrow, 'AgentEscrow', 'setFee', [bps]);
  await assert.rejects(setFee(101), /FeeTooHigh/);
  await assert.rejects(write(t.chain, t.sys.admin, t.sys.escrow, 'AgentEscrow', 'setTreasury', [zeroAddress]), /ZeroAddress/);
  const jobId = await t.open(t.quote());
  await setFee(100);
  await write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'release', [jobId]);
  assert.equal(await t.balance(t.sys.treasury.address), usd(0.05));
});

test('amounts too large for the packed job record revert instead of truncating', async () => {
  const t = await setup();
  const huge = 2n ** 128n;
  await write(t.chain, t.buyer, t.sys.usdc, 'MockUSDC', 'mint', [t.buyer.address, huge]);
  await assert.rejects(t.open(t.quote({ amount: huge, bondCover: 0n })), /SafeCastOverflowedUintDowncast/);
  assert.equal(await read(t.chain, t.sys.escrow, 'AgentEscrow', 'jobCount'), 0n);
});

test('payment goes to whoever owns the agent when the job settles', async () => {
  const t = await setup();
  const jobId = await t.open(t.quote());
  const heir = t.chain.wallet(30);
  await write(t.chain, t.provider, t.sys.registry, 'MockIdentityRegistry', 'transferFrom', [t.provider.address, heir.address, t.agentId]);
  await write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'release', [jobId]);
  assert.equal(await t.balance(heir.address), usd(9.95));
});
