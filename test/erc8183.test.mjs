// ERC8183BondHook on an ERC-8183 job escrow: the provider's cover is locked
// when the client funds, released on completion, and slashed for lateness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';
import { createChain, deployAll, deploy, read, write } from './chain.mjs';
import { usd, DAY } from './fixture.mjs';
import { bondTerms, ERC8183_SELECTORS } from '../sdk/erc8183.mjs';

const STALE_AFTER = 30 * DAY;

async function setup({ bond = 100 } = {}) {
  const chain = await createChain();
  const sys = await deployAll(chain, { registry: 'MockAgentRegistry' });
  const core = await deploy(chain, sys.admin, 'MockERC8183');
  const hook = await deploy(chain, sys.admin, 'ERC8183BondHook', [core, sys.bond, BigInt(STALE_AFTER), ERC8183_SELECTORS]);
  await write(chain, sys.admin, sys.bond, 'AgentBond', 'proposeSlasher', [hook]);
  chain.advance(7 * DAY);

  const [provider, client, evaluator, other] = [chain.wallet(10), chain.wallet(11), chain.wallet(13), chain.wallet(14)];
  await write(chain, provider, sys.registry, 'MockAgentRegistry', 'register'); // agent 1
  await write(chain, other, sys.registry, 'MockAgentRegistry', 'register'); // agent 2
  for (const w of [provider, client]) await write(chain, w, sys.usdc, 'MockUSDC', 'mint', [w.address, usd(1000)]);
  await write(chain, provider, sys.usdc, 'MockUSDC', 'approve', [sys.bond, usd(bond)]);
  if (bond) await write(chain, provider, sys.bond, 'AgentBond', 'deposit', [1n, usd(bond)]);

  const call = (who, fn, args) => write(chain, who, core, 'MockERC8183', fn, args);
  const balance = (a) => read(chain, sys.usdc, 'MockUSDC', 'balanceOf', [a]);
  const locked = async (agentId = 1n) => (await read(chain, sys.bond, 'AgentBond', 'bonds', [agentId]))[1];
  const state = async (jobId) => (await read(chain, hook, 'ERC8183BondHook', 'jobs', [jobId]))[3];

  /// Create, budget and fund a job. `terms` false: no cover offered.
  async function job({ cover = usd(20), deliverBy = chain.now() + DAY, agentId = 1n, terms = true, budgetBy = provider } = {}) {
    await call(client, 'createJob', [budgetBy.address, evaluator.address, BigInt(chain.now() + 2 * DAY), 'translate a page', hook, agentId]);
    const jobId = await read(chain, core, 'MockERC8183', 'jobCount');
    await call(budgetBy, 'setBudget', [jobId, sys.usdc, usd(10), terms ? bondTerms({ agentId, cover, deliverBy }) : '0x']);
    await write(chain, client, sys.usdc, 'MockUSDC', 'approve', [core, usd(10)]);
    await call(client, 'fund', [jobId, sys.usdc, usd(10), '0x']);
    return jobId;
  }
  return { chain, sys, core, hook, provider, client, evaluator, other, call, balance, locked, state, job };
}

const deliverable = keccak256(toHex('the translation'));

test('the hook advertises ERC-8183 hook support', async () => {
  const t = await setup();
  assert.equal(await read(t.chain, t.hook, 'ERC8183BondHook', 'supportsInterface', ['0x01ffc9a7']), true); // ERC-165
  // createJob only accepts hooks that advertise IERC8183Hook, so jobs below prove the rest.
});

test('funding locks the cover; on-time delivery and completion release it', async () => {
  const t = await setup();
  const before = await t.balance(t.provider.address);
  const jobId = await t.job();
  assert.equal(await t.locked(), usd(20));
  await t.call(t.provider, 'submit', [jobId, deliverable, '0x']);
  await t.call(t.evaluator, 'complete', [jobId, keccak256(toHex('good')), '0x']);
  assert.equal(await t.locked(), 0n);
  assert.equal((await t.balance(t.provider.address)) - before, usd(10)); // paid by the core
});

test('a client cannot fund a job whose cover is not really there', async () => {
  const t = await setup({ bond: 15 });
  const before = await t.balance(t.client.address);
  await assert.rejects(t.job({ cover: usd(20) }), /InsufficientFreeBond/);
  assert.equal(await t.balance(t.client.address), before);
});

test('missed delivery: a late submit is refused, the cover goes to the client, the budget comes back', async () => {
  const t = await setup();
  const before = await t.balance(t.client.address);
  const jobId = await t.job();
  await assert.rejects(write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'slashLate', [jobId]), /NotLate/);
  t.chain.advance(DAY + 1);
  await assert.rejects(t.call(t.provider, 'submit', [jobId, deliverable, '0x']), /late/);
  await write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'slashLate', [jobId]);
  t.chain.advance(DAY);
  await t.call(t.other, 'claimRefund', [jobId]); // ERC-8183's own refund, after its expiry
  assert.equal((await t.balance(t.client.address)) - before, usd(20)); // budget back, plus the cover
  assert.equal(await t.locked(), 0n);
});

test('only the ERC-8183 core can drive the hook', async () => {
  const t = await setup();
  await assert.rejects(write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'afterAction', [1n, ERC8183_SELECTORS.fund, '0x']), /NotCore/);
});

test("a provider can't offer another agent's bond, or back a job it hires itself", async () => {
  const t = await setup();
  await assert.rejects(t.job({ agentId: 2n }), /NotAgent/);
  // The provider funding its own job.
  await t.call(t.provider, 'createJob', [t.provider.address, t.evaluator.address, BigInt(t.chain.now() + 2 * DAY), 'x', t.hook, 1n]);
  const jobId = await read(t.chain, t.core, 'MockERC8183', 'jobCount');
  await t.call(t.provider, 'setBudget', [jobId, t.sys.usdc, usd(10), bondTerms({ agentId: 1n, cover: usd(20), deliverBy: t.chain.now() + DAY })]);
  await write(t.chain, t.provider, t.sys.usdc, 'MockUSDC', 'approve', [t.core, usd(10)]);
  await assert.rejects(t.call(t.provider, 'fund', [jobId, t.sys.usdc, usd(10), '0x']), /self-dealing/);
});

test('a quality rejection releases the cover; a rejection of a missed job slashes it', async () => {
  const t = await setup();
  const delivered = await t.job();
  await t.call(t.provider, 'submit', [delivered, deliverable, '0x']);
  await t.call(t.evaluator, 'reject', [delivered, keccak256(toHex('not good')), '0x']);
  assert.equal(await t.locked(), 0n);

  const missed = await t.job();
  t.chain.advance(DAY + 1);
  const before = await t.balance(t.client.address);
  await t.call(t.evaluator, 'reject', [missed, keccak256(toHex('never arrived')), '0x']);
  assert.equal((await t.balance(t.client.address)) - before, usd(30)); // budget refund + cover
});

test("an agent wallet's offers stay within the owner's caps", async () => {
  const t = await setup();
  const hot = t.chain.wallet(12);
  await write(t.chain, t.provider, t.sys.registry, 'MockAgentRegistry', 'setAgentWallet', [1n, hot.address]);
  await write(t.chain, t.provider, t.sys.bond, 'AgentBond', 'setWalletLimits', [1n, usd(10), usd(10), true]);
  await assert.rejects(t.job({ budgetBy: hot, cover: usd(20) }), /WalletLimitExceeded/);
  await t.job({ budgetBy: hot, cover: usd(10) });
  assert.equal(await t.locked(), usd(10));
});

test('a job delivered on time but never settled frees its cover after the stale window', async () => {
  const t = await setup();
  const jobId = await t.job();
  await t.call(t.provider, 'submit', [jobId, deliverable, '0x']);
  t.chain.advance(DAY + STALE_AFTER);
  await assert.rejects(write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'releaseStale', [jobId]), /NotStale/);
  t.chain.advance(1);
  await write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'releaseStale', [jobId]);
  assert.equal(await t.locked(), 0n);
});

test('a frozen client cannot block the slash; the cover waits for it', async () => {
  const t = await setup();
  const jobId = await t.job();
  await write(t.chain, t.sys.admin, t.sys.usdc, 'MockUSDC', 'setFrozen', [t.client.address, true]);
  t.chain.advance(DAY + 1);
  await write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'slashLate', [jobId]);
  assert.equal(await read(t.chain, t.hook, 'ERC8183BondHook', 'owed', [t.client.address]), usd(20));
  await write(t.chain, t.sys.admin, t.sys.usdc, 'MockUSDC', 'setFrozen', [t.client.address, false]);
  await write(t.chain, t.client, t.hook, 'ERC8183BondHook', 'withdrawOwed', []);
  assert.equal(await read(t.chain, t.hook, 'ERC8183BondHook', 'owed', [t.client.address]), 0n);
});

test('jobs without cover terms pass through untouched', async () => {
  const t = await setup();
  const jobId = await t.job({ terms: false });
  assert.equal(await t.locked(), 0n);
  assert.equal(await t.state(jobId), 0);
  await t.call(t.provider, 'submit', [jobId, deliverable, '0x']);
  await t.call(t.evaluator, 'complete', [jobId, keccak256(toHex('ok')), '0x']);
});
