// scripts/deploy.mjs, run against the in-process chain with a locally signing
// deployer, then the smoke run on what it deployed: the testnet sequence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { createChain, deploy, read, write } from './chain.mjs';
import { usd } from './fixture.mjs';
import { runDeploy } from '../scripts/deploy.mjs';
import { runSmoke } from '../scripts/smoke.mjs';

test('deploy configures both contracts, hands them to the owner, and a smoke job runs on the result', async () => {
  const chain = await createChain();
  const [deployer, multisig, arbiter, treasury] = [chain.wallet(0), chain.wallet(5), chain.wallet(1), chain.wallet(2)];
  const usdc = await deploy(chain, deployer, 'MockUSDC');
  const registry = await deploy(chain, deployer, 'MockAgentRegistry');
  const list = await deploy(chain, deployer, 'MockSanctionsList');

  const record = await runDeploy({
    publicClient: chain.publicClient,
    wallet: deployer.signer,
    config: {
      usdc,
      registry,
      owner: multisig.address,
      arbiter: arbiter.address,
      treasury: treasury.address,
      unbonding: 3600n,
      review: 86400n,
      arbitration: 3n * 86400n,
      feeBps: 50,
      maxJob: usd(100),
      sanctionsList: list,
    },
    log: () => {},
  });

  const bond = record.AgentBond.address;
  const escrow = record.AgentEscrow.address;
  assert.equal(await read(chain, bond, 'AgentBond', 'owner'), multisig.address);
  assert.equal(await read(chain, escrow, 'AgentEscrow', 'owner'), multisig.address);
  assert.equal(await read(chain, escrow, 'AgentEscrow', 'maxJobAmount'), usd(100));
  assert.equal(await read(chain, escrow, 'AgentEscrow', 'arbiter'), arbiter.address);
  assert.equal(await read(chain, record.SanctionsPolicy.address, 'SanctionsPolicy', 'sanctionsList'), getAddress(list));
  assert.equal(await read(chain, bond, 'AgentBond', 'isSlasher', [escrow]), false);
  assert.equal(record.owner, multisig.address);

  // After the (short, testnet) slasher delay, the smoke run works end to end.
  chain.advance(3600);
  const [owner, buyer] = [chain.wallet(10), chain.wallet(11)];
  await write(chain, owner, registry, 'MockAgentRegistry', 'register');
  for (const w of [owner, buyer]) await write(chain, w, usdc, 'MockUSDC', 'mint', [w.address, usd(100)]);
  const { report } = await runSmoke({
    publicClient: chain.publicClient,
    owner: owner.signer,
    buyer: buyer.signer,
    deployment: { usdc, ...record },
    agentId: 1n,
    amount: usd(1),
    cover: usd(2),
    log: () => {},
  });
  assert.equal(report.metrics.outcomes.released, 1);
});
