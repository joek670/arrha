// ERC8183BondHook on an ERC-8183 job escrow: the provider's cover is locked
// when the client funds, released on completion, and slashed for lateness.
// The scenarios run on the minimal mock and on the vendored reference
// implementation (contracts/mocks/erc8183-reference/), plain and with signed
// authorizations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, toHex } from 'viem';
import { abi, createChain, deployAll, deploy, read, write, CHAIN_ID } from './chain.mjs';
import { usd, DAY } from './fixture.mjs';
import { bondTerms, ERC8183_SELECTORS } from '../sdk/erc8183.mjs';

const STALE_AFTER = 30 * DAY;
const CORES = ['MockERC8183', 'ERC8183', 'ERC8183WithAuthorization'];

/// The reference runs behind its UUPS proxy, and its admin must allow the
/// payment token and whitelist the hook.
async function deployCore(chain, sys, name) {
  if (name === 'MockERC8183') return deploy(chain, sys.admin, name);
  const implementation = await deploy(chain, sys.admin, name);
  const init = encodeFunctionData({ abi: abi(name), functionName: 'initialize', args: [sys.treasury.address, sys.admin.address] });
  const core = await deploy(chain, sys.admin, 'ERC8183Proxy', [implementation, init]);
  await write(chain, sys.admin, core, name, 'setPaymentTokenAllowed', [sys.usdc, true]);
  return core;
}

async function setup({ bond = 100, core: coreName = 'MockERC8183' } = {}) {
  // ERC8183WithAuthorization is over EIP-170's size limit (docs/erc-8183-hook.md).
  const chain = await createChain({ unlimitedCodeSize: coreName === 'ERC8183WithAuthorization' });
  const sys = await deployAll(chain, { registry: 'MockAgentRegistry' });
  const core = await deployCore(chain, sys, coreName);
  const hook = await deploy(chain, sys.admin, 'ERC8183BondHook', [core, sys.bond, BigInt(STALE_AFTER), ERC8183_SELECTORS]);
  if (coreName !== 'MockERC8183') await write(chain, sys.admin, core, coreName, 'setHookWhitelist', [hook, true]);
  await write(chain, sys.admin, sys.bond, 'AgentBond', 'proposeSlasher', [hook]);
  chain.advance(7 * DAY);

  const [provider, client, hot, evaluator, other] = [chain.wallet(10), chain.wallet(11), chain.wallet(12), chain.wallet(13), chain.wallet(14)];
  await write(chain, provider, sys.registry, 'MockAgentRegistry', 'register'); // agent 1
  await write(chain, other, sys.registry, 'MockAgentRegistry', 'register'); // agent 2
  for (const w of [provider, client, hot]) await write(chain, w, sys.usdc, 'MockUSDC', 'mint', [w.address, usd(1000)]);
  await write(chain, provider, sys.usdc, 'MockUSDC', 'approve', [sys.bond, usd(bond)]);
  if (bond) await write(chain, provider, sys.bond, 'AgentBond', 'deposit', [1n, usd(bond)]);

  const call = (who, fn, args) => write(chain, who, core, coreName, fn, args);
  const balance = (a) => read(chain, sys.usdc, 'MockUSDC', 'balanceOf', [a]);
  const locked = async (agentId = 1n) => (await read(chain, sys.bond, 'AgentBond', 'bonds', [agentId]))[1];
  const state = async (jobId) => (await read(chain, hook, 'ERC8183BondHook', 'jobs', [jobId]))[3];

  /// Create, budget and fund a job that expires in two days. `terms` false:
  /// no cover offered.
  async function job({ cover = usd(20), deliverBy = chain.now() + DAY, agentId = 1n, terms = true, budgetBy = provider, fundBy = client } = {}) {
    await call(fundBy, 'createJob', [budgetBy.address, evaluator.address, chain.now() + 2 * DAY, 'translate a page', hook, agentId]);
    const jobId = await read(chain, core, coreName, 'jobCounter');
    await call(budgetBy, 'setBudget', [jobId, sys.usdc, usd(10), terms ? bondTerms({ agentId, cover, deliverBy }) : '0x']);
    await write(chain, fundBy, sys.usdc, 'MockUSDC', 'approve', [core, usd(10)]);
    await call(fundBy, 'fund', [jobId, sys.usdc, usd(10), '0x']);
    return jobId;
  }
  return { chain, sys, core, hook, provider, client, hot, evaluator, other, call, balance, locked, state, job };
}

const deliverable = keccak256(toHex('the translation'));
const slashLate = (t, jobId) => write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'slashLate', [jobId]);

test('the hook advertises ERC-8183 hook support', async () => {
  const t = await setup();
  assert.equal(await read(t.chain, t.hook, 'ERC8183BondHook', 'supportsInterface', ['0x01ffc9a7']), true); // ERC-165
  // createJob only accepts hooks that advertise IERC8183Hook, so jobs below prove the rest.
});

test('only the ERC-8183 core can drive the hook', async () => {
  const t = await setup();
  await assert.rejects(write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'afterAction', [1n, ERC8183_SELECTORS.fund, '0x']), /NotCore/);
});

for (const core of CORES) {
  const it = (title, fn) => test(`${core}: ${title}`, fn);
  const reference = core !== 'MockERC8183';

  it('funding locks the cover; on-time delivery and completion release it', async () => {
    const t = await setup({ core });
    const before = await t.balance(t.provider.address);
    const jobId = await t.job();
    assert.equal(await t.locked(), usd(20));
    await t.call(t.provider, 'submit', [jobId, deliverable, '0x']);
    await t.call(t.evaluator, 'complete', [jobId, keccak256(toHex('good')), '0x']);
    assert.equal(await t.locked(), 0n);
    assert.equal((await t.balance(t.provider.address)) - before, usd(10)); // paid by the core
  });

  it('a client cannot fund a job whose cover is not really there', async () => {
    const t = await setup({ core, bond: 15 });
    const before = await t.balance(t.client.address);
    await assert.rejects(t.job({ cover: usd(20) }), /InsufficientFreeBond/);
    assert.equal(await t.balance(t.client.address), before);
  });

  it('missed delivery: a late submit is refused, the cover goes to the client, the budget comes back', async () => {
    const t = await setup({ core });
    const before = await t.balance(t.client.address);
    const jobId = await t.job();
    await assert.rejects(slashLate(t, jobId), /NotLate/);
    t.chain.advance(DAY + 1);
    await assert.rejects(t.call(t.provider, 'submit', [jobId, deliverable, '0x']), /late/);
    await slashLate(t, jobId);
    t.chain.advance(DAY);
    await t.call(t.other, 'claimRefund', [jobId]); // ERC-8183's own refund, after its expiry
    assert.equal((await t.balance(t.client.address)) - before, usd(20)); // budget back, plus the cover
    assert.equal(await t.locked(), 0n);
  });

  it('the delivery deadline must come before the job expires', async () => {
    const t = await setup({ core });
    // t.job's jobs expire two days out, and the core refuses a submission from then on.
    await assert.rejects(t.job({ deliverBy: t.chain.now() + 2 * DAY }), /deliverBy/);
    await t.job({ deliverBy: t.chain.now() + 2 * DAY - 1 });
    assert.equal(await t.locked(), usd(20));
  });

  it("a provider can't offer another agent's bond, or back a job it hires itself", async () => {
    const t = await setup({ core });
    await assert.rejects(t.job({ agentId: 2n }), /NotAgent/);
    await write(t.chain, t.provider, t.sys.registry, 'MockAgentRegistry', 'setAgentWallet', [1n, t.hot.address]);
    // The agent's wallet funds a job its owner provides, and the reverse.
    await assert.rejects(t.job({ fundBy: t.hot }), /self-dealing/);
    await assert.rejects(t.job({ budgetBy: t.hot, fundBy: t.provider }), /self-dealing/);
  });

  it('a quality rejection releases the cover; a rejection of a missed job slashes it', async () => {
    const t = await setup({ core });
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

  it("an agent wallet's offers stay within the owner's caps", async () => {
    const t = await setup({ core });
    await write(t.chain, t.provider, t.sys.registry, 'MockAgentRegistry', 'setAgentWallet', [1n, t.hot.address]);
    await write(t.chain, t.provider, t.sys.bond, 'AgentBond', 'setWalletLimits', [1n, usd(10), usd(10), true]);
    await assert.rejects(t.job({ budgetBy: t.hot, cover: usd(20) }), /WalletLimitExceeded/);
    await t.job({ budgetBy: t.hot, cover: usd(10) });
    assert.equal(await t.locked(), usd(10));
  });

  it('a job delivered on time but never settled frees its cover after the stale window', async () => {
    const t = await setup({ core });
    const jobId = await t.job();
    await t.call(t.provider, 'submit', [jobId, deliverable, '0x']);
    t.chain.advance(DAY + STALE_AFTER);
    await assert.rejects(write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'releaseStale', [jobId]), /NotStale/);
    t.chain.advance(1);
    await write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'releaseStale', [jobId]);
    assert.equal(await t.locked(), 0n);
  });

  it('a frozen client cannot block the slash; the cover waits for it', async () => {
    const t = await setup({ core });
    const jobId = await t.job();
    await write(t.chain, t.sys.admin, t.sys.usdc, 'MockUSDC', 'setFrozen', [t.client.address, true]);
    t.chain.advance(DAY + 1);
    await slashLate(t, jobId);
    assert.equal(await read(t.chain, t.hook, 'ERC8183BondHook', 'owed', [t.client.address]), usd(20));
    await write(t.chain, t.sys.admin, t.sys.usdc, 'MockUSDC', 'setFrozen', [t.client.address, false]);
    await write(t.chain, t.client, t.hook, 'ERC8183BondHook', 'withdrawOwed', []);
    assert.equal(await read(t.chain, t.hook, 'ERC8183BondHook', 'owed', [t.client.address]), 0n);
  });

  it('jobs without cover terms pass through untouched', async () => {
    const t = await setup({ core });
    const jobId = await t.job({ terms: false });
    assert.equal(await t.locked(), 0n);
    assert.equal(await t.state(jobId), 0);
    await t.call(t.provider, 'submit', [jobId, deliverable, '0x']);
    await t.call(t.evaluator, 'complete', [jobId, keccak256(toHex('ok')), '0x']);
  });

  if (!reference) continue;

  it("an admin detaching the hook can't get an on-time provider slashed", async () => {
    const t = await setup({ core });
    const jobId = await t.job();
    await t.call(t.sys.admin, 'batchDetachHook', [[jobId]]);
    await t.call(t.provider, 'submit', [jobId, deliverable, '0x']); // on time; the hook doesn't see it
    t.chain.advance(DAY + 1);
    await assert.rejects(slashLate(t, jobId), /NotLate/); // the core's record shows the submission
    await t.call(t.evaluator, 'complete', [jobId, keccak256(toHex('good')), '0x']); // unseen too
    t.chain.advance(STALE_AFTER);
    await write(t.chain, t.other, t.hook, 'ERC8183BondHook', 'releaseStale', [jobId]);
    const [total, locked] = await read(t.chain, t.sys.bond, 'AgentBond', 'bonds', [1n]);
    assert.deepEqual([total, locked], [usd(100), 0n]);
  });

  it('after a detach, a provider that misses the deadline is still slashed', async () => {
    const t = await setup({ core });
    const before = await t.balance(t.client.address);
    const jobId = await t.job();
    await t.call(t.sys.admin, 'batchDetachHook', [[jobId]]);
    t.chain.advance(DAY + 1);
    await t.call(t.provider, 'submit', [jobId, deliverable, '0x']); // late, and no hook refuses it
    await slashLate(t, jobId);
    assert.equal((await t.balance(t.client.address)) - before, usd(10)); // the cover, less the budget still in escrow
    assert.equal(await t.locked(), 0n);
  });

  it('milestone claims are not delivery: paid claims without a submit still get the cover slashed', async () => {
    const t = await setup({ core });
    const jobId = await t.job();
    const milestone = keccak256(toHex('the first half'));
    await t.call(t.provider, 'submitClaim', [jobId, usd(5), milestone, '0x']);
    await t.call(t.client, 'approveClaim', [jobId, usd(5), milestone, '0x']);
    t.chain.advance(DAY + 1);
    await slashLate(t, jobId);
    assert.equal(await t.locked(), 0n);
  });

  it('known limit: a core pause across the deadline leaves an on-time provider slashable', async () => {
    // README "Limits": the core refuses submissions while paused, and the hook
    // can't tell how long a pause lasted.
    const t = await setup({ core });
    const jobId = await t.job();
    await t.call(t.sys.admin, 'pause', []);
    await assert.rejects(t.call(t.provider, 'submit', [jobId, deliverable, '0x']), /EnforcedPause/);
    t.chain.advance(DAY + 1);
    await t.call(t.sys.admin, 'unpause', []);
    await assert.rejects(t.call(t.provider, 'submit', [jobId, deliverable, '0x']), /late/);
    await slashLate(t, jobId);
    assert.equal(await t.locked(), 0n);
  });
}

test('ERC8183WithAuthorization: a facilitator relays the signed steps of a bonded job (the x402 job-escrow flow)', async () => {
  const t = await setup({ core: 'ERC8183WithAuthorization' });
  const facilitator = t.chain.wallet(15);
  const domain = { name: 'ERC8183', version: '1', chainId: CHAIN_ID, verifyingContract: t.core };
  let nonce = 0n;
  /// An EIP-712 authorization from `signer` for `primaryType`, whose fields
  /// sit between `signer` and `nonce, deadline` in the type.
  const authorize = async (signer, primaryType, fields) => {
    const message = { signer: signer.address, ...Object.fromEntries(fields.map((f) => [f.name, f.value])), nonce: ++nonce, deadline: BigInt(t.chain.now() + 3600) };
    const types = {
      [primaryType]: [
        { name: 'signer', type: 'address' },
        ...fields.map(({ name, type }) => ({ name, type })),
        { name: 'nonce', type: 'uint72' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    const sig = await signer.account.signTypedData({ domain, types, primaryType, message });
    return { signer: signer.address, nonce: message.nonce, deadline: message.deadline, sig };
  };
  const relay = (fn, args) => t.call(facilitator, fn, args);
  const noParams = keccak256('0x');

  // The client creates the job itself, then only signs.
  await t.call(t.client, 'createJob', [t.provider.address, t.evaluator.address, t.chain.now() + 2 * DAY, 'translate a page', t.hook, 1n]);
  const jobId = await read(t.chain, t.core, 'ERC8183WithAuthorization', 'jobCounter');
  const terms = bondTerms({ agentId: 1n, cover: usd(20), deliverBy: t.chain.now() + DAY });
  await relay('setBudgetWithAuthorization', [jobId, t.sys.usdc, usd(10), terms, await authorize(t.provider, 'SetBudgetAuthorization', [
    { name: 'jobId', type: 'uint256', value: jobId },
    { name: 'token', type: 'address', value: t.sys.usdc },
    { name: 'amount', type: 'uint256', value: usd(10) },
    { name: 'optParamsHash', type: 'bytes32', value: keccak256(terms) },
  ])]);
  await write(t.chain, t.client, t.sys.usdc, 'MockUSDC', 'approve', [t.core, usd(10)]);
  await relay('fundWithAuthorization', [jobId, t.sys.usdc, usd(10), '0x', await authorize(t.client, 'FundAuthorization', [
    { name: 'jobId', type: 'uint256', value: jobId },
    { name: 'expectedToken', type: 'address', value: t.sys.usdc },
    { name: 'expectedBudget', type: 'uint256', value: usd(10) },
    { name: 'optParamsHash', type: 'bytes32', value: noParams },
  ])]);
  assert.equal(await t.locked(), usd(20)); // the hook saw the signers, not the facilitator

  await relay('submitWithAuthorization', [jobId, deliverable, '0x', await authorize(t.provider, 'SubmitAuthorization', [
    { name: 'jobId', type: 'uint256', value: jobId },
    { name: 'deliverable', type: 'bytes32', value: deliverable },
    { name: 'optParamsHash', type: 'bytes32', value: noParams },
  ])]);
  const { submittedAt } = await read(t.chain, t.core, 'ERC8183WithAuthorization', 'getJob', [jobId]);
  const reason = keccak256(toHex('good'));
  await relay('completeWithAuthorization', [jobId, reason, '0x', await authorize(t.evaluator, 'CompleteAuthorization', [
    { name: 'jobId', type: 'uint256', value: jobId },
    { name: 'submittedAt', type: 'uint48', value: submittedAt },
    { name: 'reason', type: 'bytes32', value: reason },
    { name: 'optParamsHash', type: 'bytes32', value: noParams },
  ])]);
  assert.equal(await t.locked(), 0n);
});
