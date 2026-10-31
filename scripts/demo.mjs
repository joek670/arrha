// Walks through two agent jobs on the in-process chain and prints what
// happens to the money (one delivered, one missed deadline), then the risk
// report the next buyer would read.
import { formatUnits, parseUnits } from 'viem';
import { createChain, deployAll, write, read, CHAIN_ID } from '../test/chain.mjs';
import { newQuote, signQuote, toX402Extra, fromX402Requirements, checkTrust, openJob, termsHash } from '../sdk/arrha.mjs';
import { agentRiskReport } from '../sdk/risk.mjs';

const usd = (n) => parseUnits(String(n), 6);
const show = (n) => `$${formatUnits(n, 6)}`;
const tx = { gas: 30_000_000n, gasPrice: 0n };

const chain = await createChain();
const sys = await deployAll(chain, { feeBps: 50 });
const provider = chain.wallet(10);
const buyer = chain.wallet(11);

await write(chain, provider, sys.registry, 'MockIdentityRegistry', 'register');
const agentId = 1n;
for (const w of [provider, buyer]) await write(chain, w, sys.usdc, 'MockUSDC', 'mint', [w.address, usd(500)]);
await write(chain, provider, sys.usdc, 'MockUSDC', 'approve', [sys.bond, usd(100)]);
await write(chain, provider, sys.bond, 'AgentBond', 'deposit', [agentId, usd(100)]);
console.log(`Provider agent #${agentId} registered (ERC-8004) and bonded ${show(usd(100))}.`);

async function offer(task) {
  const quote = newQuote({ agentId, amount: usd(10), bondCover: usd(20), deadline: chain.now() + 3600, expiry: chain.now() + 300, terms: termsHash({ task }) });
  const signature = await signQuote(provider.account, { chainId: CHAIN_ID, escrow: sys.escrow, quote });
  // What the provider's API would return with HTTP 402.
  return JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base-sepolia', extra: toX402Extra({ chainId: CHAIN_ID, escrow: sys.escrow, bond: sys.bond, quote, signature }) }] });
}

async function hire(body) {
  const o = fromX402Requirements(JSON.parse(body).accepts[0]);
  const trust = await checkTrust(chain.publicClient, { bond: o.bond, quote: o.quote, minCoverBps: 10_000 });
  console.log(`  Buyer checks the bond: ${show(trust.free)} free, quote covers ${show(o.quote.bondCover)} -> ${trust.ok ? 'OK' : trust.reasons.join('; ')}`);
  const jobId = await openJob({ walletClient: buyer.client, publicClient: chain.publicClient, escrow: o.escrow, paymentToken: sys.usdc, quote: o.quote, signature: o.signature, txOptions: tx });
  console.log(`  Job #${jobId} opened: ${show(o.quote.amount)} in escrow, ${show(o.quote.bondCover)} of bond locked.`);
  return jobId;
}

const balances = async (label) => {
  const [total, locked] = await read(chain, sys.bond, 'AgentBond', 'bonds', [agentId]);
  const b = (a) => read(chain, sys.usdc, 'MockUSDC', 'balanceOf', [a]);
  console.log(`  ${label}: provider ${show(await b(provider.address))}, buyer ${show(await b(buyer.address))}, treasury ${show(await b(sys.treasury.address))}, bond ${show(total)} (${show(locked)} locked)`);
};

console.log('\n1. Delivered job');
const job1 = await hire(await offer('summarise a PDF'));
await write(chain, provider, sys.escrow, 'AgentEscrow', 'submit', [job1, termsHash({ summary: '...' })]);
await write(chain, buyer, sys.escrow, 'AgentEscrow', 'release', [job1]);
await balances('Released');

console.log('\n2. Missed deadline');
const job2 = await hire(await offer('translate a page'));
chain.advance(3601);
await write(chain, chain.wallet(20), sys.escrow, 'AgentEscrow', 'refundLate', [job2]);
await balances('Refunded and slashed');
console.log('\nThe buyer got its $10 back plus the $20 cover. No arbiter, no support ticket.');

console.log('\n3. What the next buyer sees');
const report = await agentRiskReport(chain.publicClient, { escrow: sys.escrow, bond: sys.bond, agentId });
console.log(`  Agent #${agentId}: score ${report.score}/100, ${report.band} risk`);
for (const line of report.explanation) console.log(`  - ${line}`);
for (const f of report.flags) console.log(`  ${f.points}  ${f.reason}`);
