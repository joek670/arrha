// Gas for deploying the contracts and for each step of a job, measured on the
// in-process EVM. Totals add what a real transaction pays on top of execution:
// the 21,000 base, calldata (with EIP-7623's floor), contract-creation costs,
// and the capped refund. Expect them within a few percent of Base, which
// warms some addresses this EVM charges as cold. Base also adds a small L1
// data fee per transaction, not counted here.
import { formatEther, hexToBytes, parseUnits } from 'viem';
import { createChain, deploy, write, CHAIN_ID } from '../test/chain.mjs';
import { newQuote, signQuote, openJob, openJobWithAuthorization, signOpenAuthorization, termsHash } from '../sdk/arrha.mjs';
import { ERC8183_SELECTORS } from '../sdk/erc8183.mjs';

const usd = (n) => parseUnits(String(n), 6);
const DAY = 86400;
const tx = { gas: 30_000_000n, gasPrice: 0n };

function gasOf({ tx: t, result }) {
  const data = hexToBytes(t.data ?? '0x');
  const zero = data.filter((b) => b === 0).length;
  const nonzero = data.length - zero;
  const create = !t.to;
  const intrinsic = 21_000 + 4 * zero + 16 * nonzero + (create ? 32_000 + 2 * Math.ceil(data.length / 32) : 0);
  const used = intrinsic + Number(result.execResult.executionGasUsed);
  const refund = Math.min(Number(result.execResult.gasRefund ?? 0n), Math.floor(used / 5));
  const floor = 21_000 + 10 * (zero + 4 * nonzero);
  return Math.max(used - refund, floor);
}

let label = null;
const rows = new Map();
const chain = await createChain({
  onTransaction: (t) => {
    if (label) rows.set(label, (rows.get(label) ?? 0) + gasOf(t));
  },
});
async function measure(name, fn) {
  label = name;
  try {
    return await fn();
  } finally {
    label = null;
  }
}

const [admin, arbiter, treasury] = [chain.wallet(0), chain.wallet(1), chain.wallet(2)];
const owner = chain.wallet(10);
const buyer = chain.wallet(11);

// Stand-ins the real deployment doesn't pay for: USDC, the ERC-8004 registry.
const usdc = await deploy(chain, admin, 'MockUSDC');
const registry = await deploy(chain, admin, 'MockIdentityRegistry');
const list = await deploy(chain, admin, 'MockSanctionsList');

const bond = await measure('Deploy AgentBond', () => deploy(chain, admin, 'AgentBond', [usdc, registry, BigInt(7 * DAY), admin.address]));
const escrow = await measure('Deploy AgentEscrow', () =>
  deploy(chain, admin, 'AgentEscrow', [usdc, bond, BigInt(DAY), BigInt(3 * DAY), arbiter.address, treasury.address, 50, admin.address]),
);
const policy = await measure('Deploy SanctionsPolicy (optional)', () => deploy(chain, admin, 'SanctionsPolicy', [list]));
// The hook's core address only matters at call time; any address measures the deployment.
await measure('Deploy ERC8183BondHook (optional)', () => deploy(chain, admin, 'ERC8183BondHook', [admin.address, bond, BigInt(30 * DAY), ERC8183_SELECTORS]));
await measure('Approve the escrow as a slasher', () => write(chain, admin, bond, 'AgentBond', 'proposeSlasher', [escrow]));
chain.advance(7 * DAY);

await write(chain, owner, registry, 'MockIdentityRegistry', 'register');
for (const w of [owner, buyer]) await write(chain, w, usdc, 'MockUSDC', 'mint', [w.address, usd(1000)]);
await measure('Agent: approve USDC and post a bond', async () => {
  await write(chain, owner, usdc, 'MockUSDC', 'approve', [bond, usd(100)]);
  await write(chain, owner, bond, 'AgentBond', 'deposit', [1n, usd(100)]);
});

async function job(over = {}) {
  const quote = newQuote({ agentId: 1n, amount: usd(10), bondCover: usd(20), deadline: chain.now() + DAY, expiry: chain.now() + 600, terms: termsHash({ n: rows.size, ...over }), ...over });
  const signature = await signQuote(owner.account, { chainId: CHAIN_ID, escrow, quote });
  return openJob({ walletClient: buyer.client, publicClient: chain.publicClient, escrow, paymentToken: usdc, quote, signature, txOptions: tx });
}
const send = (who, fn, args) => write(chain, who, escrow, 'AgentEscrow', fn, args);

await job(); // warm up storage the first job initialises, so the rows below are typical
const a = await measure('Buyer: approve USDC and open a job', () => job());
await measure('Buyer: open a job with a sanctions policy', () => job({ policy }));
await measure("Relayer: open a job with the buyer's USDC authorisation (no approve)", async () => {
  const quote = newQuote({ agentId: 1n, amount: usd(10), bondCover: usd(20), deadline: chain.now() + DAY, expiry: chain.now() + 600, terms: termsHash({ gasless: true }) });
  const signature = await signQuote(owner.account, { chainId: CHAIN_ID, escrow, quote });
  const authorization = await signOpenAuthorization(buyer.account, { publicClient: chain.publicClient, paymentToken: usdc, escrow, quote, validBefore: BigInt(chain.now() + 3600) });
  return openJobWithAuthorization({ walletClient: chain.wallet(30).client, publicClient: chain.publicClient, escrow, quote, signature, authorization, txOptions: tx });
});
await measure('Agent: submit the result', () => send(owner, 'submit', [a, termsHash({ done: true })]));
await measure('Buyer: release payment', () => send(buyer, 'release', [a]));

const late = await job();
chain.advance(DAY + 1);
await measure('Anyone: refund a late job and slash its cover', () => send(buyer, 'refundLate', [late]));

const disputed = await job();
await send(owner, 'submit', [disputed, termsHash({ bad: true })]);
await measure('Buyer: dispute', () => send(buyer, 'dispute', [disputed]));
await measure('Arbiter: resolve a dispute', () => send(arbiter, 'resolve', [disputed, 5_000, usd(5)]));

const gwei = [0.01, 0.1];
console.log(`| Step | Gas | ${gwei.map((g) => `ETH at ${g} gwei`).join(' | ')} |`);
console.log(`|---|---:|${gwei.map(() => '---:').join('|')}|`);
for (const [name, gas] of rows) {
  const eth = gwei.map((g) => formatEther(BigInt(Math.round(gas * g * 1e9))));
  console.log(`| ${name} | ${gas.toLocaleString('en-US')} | ${eth.join(' | ')} |`);
}
const happy = ['Buyer: approve USDC and open a job', 'Agent: submit the result', 'Buyer: release payment'].reduce((s, k) => s + rows.get(k), 0);
console.log(`\nA delivered job end to end (open, submit, release): ${happy.toLocaleString('en-US')} gas.`);
