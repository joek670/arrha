// scripts/smoke.mjs, run against the in-process chain with locally signed
// transactions, the way it runs against Base Sepolia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChain, deployAll, deploy, read, write } from './chain.mjs';
import { usd } from './fixture.mjs';
import { runSmoke } from '../scripts/smoke.mjs';

async function deployed() {
  const chain = await createChain();
  const sys = await deployAll(chain, { registry: 'MockAgentRegistry' });
  const [owner, buyer] = [chain.wallet(10), chain.wallet(11)];
  await write(chain, owner, sys.registry, 'MockAgentRegistry', 'register');
  for (const w of [owner, buyer]) await write(chain, w, sys.usdc, 'MockUSDC', 'mint', [w.address, usd(100)]);
  const deployment = { usdc: sys.usdc, AgentBond: { address: sys.bond, block: 0 }, AgentEscrow: { address: sys.escrow, block: 0 } };
  return { chain, sys, owner, buyer, deployment };
}

test('the smoke run bonds the agent and takes one job from quote to release', async () => {
  const { chain, sys, owner, buyer, deployment } = await deployed();
  const lines = [];
  const { jobId, report } = await runSmoke({
    publicClient: chain.publicClient,
    owner: owner.signer,
    buyer: buyer.signer,
    deployment,
    agentId: 1n,
    amount: usd(1),
    cover: usd(2),
    log: (line) => lines.push(line),
  });
  assert.equal(jobId, 1n);
  assert.equal(report.metrics.outcomes.released, 1);
  const [total, locked] = await read(chain, sys.bond, 'AgentBond', 'bonds', [1n]);
  assert.deepEqual([total, locked], [usd(2), 0n]);
  assert.match(lines[0], /Bonding agent 1: \$2/);
});

test('the smoke run stops with a clear message while the slasher delay runs', async () => {
  const { chain, sys, owner, buyer, deployment } = await deployed();
  const { admin, arbiter, treasury } = sys;
  const fresh = await deploy(chain, admin, 'AgentEscrow', [sys.usdc, sys.bond, 86400n, 3n * 86400n, arbiter.address, treasury.address, 50, admin.address]);
  await write(chain, admin, sys.bond, 'AgentBond', 'proposeSlasher', [fresh]);
  await assert.rejects(
    runSmoke({ publicClient: chain.publicClient, owner: owner.signer, buyer: buyer.signer, deployment: { ...deployment, AgentEscrow: { address: fresh, block: 0 } }, agentId: 1n, amount: usd(1), cover: usd(2), log: () => {} }),
    /can't lock bond until .* \(the slasher delay\)/,
  );
});
