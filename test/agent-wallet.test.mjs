// Agents run on a hot key, their owners keep a cold one. ERC-8004 gives each
// agent a verified agent wallet; the escrow lets it do the work and get paid,
// while the bond stays under the owner's control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zeroAddress } from 'viem';
import { deploy, read, write } from './chain.mjs';
import { setup, usd } from './fixture.mjs';
import { checkTrust, termsHash } from '../sdk/arrha.mjs';

async function withAgentWallet() {
  const t = await setup({ registry: 'MockAgentRegistry' });
  const hot = t.chain.wallet(12);
  await write(t.chain, t.provider, t.sys.registry, 'MockAgentRegistry', 'setAgentWallet', [t.agentId, hot.address]);
  return { ...t, hot };
}

const escrowRead = (t, fn, args) => read(t.chain, t.sys.escrow, 'AgentEscrow', fn, args);

test('the agent wallet signs quotes, submits results and is paid', async () => {
  const t = await withAgentWallet();
  const ownerBefore = await t.balance(t.provider.address);
  const q = t.quote();
  const jobId = await t.open(q, await t.sign(q, t.hot.account));
  await write(t.chain, t.hot, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({ ok: true })]);
  await write(t.chain, t.buyer, t.sys.escrow, 'AgentEscrow', 'release', [jobId]);

  assert.equal(await escrowRead(t, 'payeeOf', [t.agentId]), t.hot.address);
  assert.equal(await t.balance(t.hot.address), usd(9.95));
  assert.equal(await t.balance(t.provider.address), ownerBefore);
});

test('only the owner controls the bond', async () => {
  const t = await withAgentWallet();
  await assert.rejects(write(t.chain, t.hot, t.sys.bond, 'AgentBond', 'requestWithdrawal', [t.agentId, usd(1)]), /NotAgentOwner/);
});

test("the owner can still sign; strangers can't sign or submit; the agent wallet can't hire itself", async () => {
  const t = await withAgentWallet();
  const q = t.quote();
  const jobId = await t.open(q, await t.sign(q));

  const stranger = t.chain.wallet(20);
  const forged = t.quote();
  await assert.rejects(t.open(forged, await t.sign(forged, stranger.account)), /BadSignature/);
  await assert.rejects(write(t.chain, stranger, t.sys.escrow, 'AgentEscrow', 'submit', [jobId, termsHash({})]), /NotProvider/);

  const own = t.quote();
  await assert.rejects(t.open(own, await t.sign(own, t.hot.account), t.hot), /self-dealing/);
});

test('a registry without agent wallets falls back to the owner', async () => {
  const t = await setup();
  assert.equal(await escrowRead(t, 'agentWallet', [t.agentId]), zeroAddress);
  assert.equal(await escrowRead(t, 'payeeOf', [t.agentId]), t.provider.address);
  assert.equal(await escrowRead(t, 'actsFor', [t.agentId, t.provider.address]), true);
  assert.equal(await escrowRead(t, 'actsFor', [t.agentId, zeroAddress]), false);
});

test("a buyer's screen also covers the agent wallet that gets paid", async () => {
  const t = await withAgentWallet();
  const list = await deploy(t.chain, t.sys.admin, 'MockSanctionsList');
  const screen = await deploy(t.chain, t.sys.admin, 'SanctionsPolicy', [list]);
  await write(t.chain, t.sys.admin, list, 'MockSanctionsList', 'set', [t.hot.address, true]);
  const trust = await checkTrust(t.chain.publicClient, { bond: t.sys.bond, quote: t.quote(), screen });
  assert.equal(trust.ok, false);
  assert.match(trust.reasons[0], /provider agent wallet/);
});

test('a guarded launch can cap job size', async () => {
  const t = await setup();
  const cap = (amount, who = t.sys.admin) => write(t.chain, who, t.sys.escrow, 'AgentEscrow', 'setMaxJobAmount', [amount]);
  await assert.rejects(cap(1n, t.buyer), /OwnableUnauthorizedAccount/);
  await cap(usd(25));
  await assert.rejects(t.open(t.quote({ amount: usd(26) })), /too large/);
  assert.equal(await t.open(t.quote({ amount: usd(25) })), 1n);
  await cap(0n);
  assert.equal(await t.open(t.quote({ amount: usd(500) })), 2n);
});

test('the owner caps what the agent wallet can commit, per job and per day', async () => {
  const t = await withAgentWallet();
  const limits = (who, perJob, perDay, enabled = true) =>
    write(t.chain, who, t.sys.bond, 'AgentBond', 'setWalletLimits', [t.agentId, perJob, perDay, enabled]);
  await assert.rejects(limits(t.hot, usd(1000), usd(1000)), /NotAgentOwner/);
  await limits(t.provider, usd(15), usd(25));

  const byWallet = async (cover) => {
    const q = t.quote({ bondCover: cover });
    return t.open(q, await t.sign(q, t.hot.account));
  };
  await assert.rejects(byWallet(usd(20)), /WalletLimitExceeded/);
  await byWallet(usd(15));
  await assert.rejects(byWallet(usd(15)), /WalletLimitExceeded/); // 30 > 25 today
  await byWallet(usd(10)); // exactly 25

  // The owner's own quotes aren't capped, and the daily budget resets.
  const ownerQuote = t.quote({ bondCover: usd(20) });
  await t.open(ownerQuote, await t.sign(ownerQuote));
  t.chain.advance(86400);
  await byWallet(usd(15));
});

test('a zero cap stops the agent wallet committing any cover', async () => {
  const t = await withAgentWallet();
  await write(t.chain, t.provider, t.sys.bond, 'AgentBond', 'setWalletLimits', [t.agentId, 0n, 0n, true]);
  const covered = t.quote({ bondCover: 1n });
  await assert.rejects(t.open(covered, await t.sign(covered, t.hot.account)), /WalletLimitExceeded/);
  const uncovered = t.quote({ bondCover: 0n });
  assert.equal(await t.open(uncovered, await t.sign(uncovered, t.hot.account)), 1n);
});
