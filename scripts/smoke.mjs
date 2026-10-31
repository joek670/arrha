// One real job on a deployed system: bond the agent if it needs it, quote,
// open, submit, release, then print the agent's risk report. Run it right
// after scripts/deploy.mjs, once the escrow's slasher delay has passed.
//
//   OWNER_KEY=0x... BUYER_KEY=0x... AGENT_ID=42 node scripts/smoke.mjs
//
// OWNER_KEY owns AGENT_ID in the ERC-8004 registry (register the agent
// first with any ERC-8004 tool). Both keys need a little ETH for gas, and
// both need test USDC (https://faucet.circle.com): the owner for the bond,
// the buyer for the job. Addresses come from deployments/<network>.json.
// Optional: CHAIN=base, RPC_URL, JOB_USD (default 1), COVER_USD (default 2).
// Use throwaway testnet keys only.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { checkTrust, newQuote, openJob, signQuote, termsHash } from '../sdk/arrha.mjs';
import { agentRiskReport } from '../sdk/risk.mjs';

const artifacts = JSON.parse(readFileSync(new URL('../build/contracts.json', import.meta.url)));
const money = (n) => `$${formatUnits(n, 6)}`;

export async function runSmoke({ publicClient, owner, buyer, deployment, agentId, amount, cover, log = console.log }) {
  const bond = deployment.AgentBond.address;
  const escrow = deployment.AgentEscrow.address;
  const usdc = deployment.usdc;
  const read = (address, name, functionName, args = []) => publicClient.readContract({ address, abi: artifacts[name].abi, functionName, args });
  // Simulate first, so a revert comes back with its reason before any gas is spent.
  async function send(wallet, address, abi, functionName, args) {
    const { request } = await publicClient.simulateContract({ account: wallet.account, address, abi, functionName, args });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted in ${hash}`);
    return receipt;
  }

  if (!(await read(bond, 'AgentBond', 'isSlasher', [escrow]))) {
    const at = await read(bond, 'AgentBond', 'slasherActiveAt', [escrow]);
    throw new Error(`the escrow can't lock bond until ${new Date(Number(at) * 1000).toISOString()} (the slasher delay)`);
  }
  if (!(await read(escrow, 'AgentEscrow', 'actsFor', [agentId, owner.account.address]))) {
    throw new Error(`${owner.account.address} neither owns agent ${agentId} nor is its agent wallet`);
  }

  const free = await read(bond, 'AgentBond', 'freeBond', [agentId]);
  if (free < cover) {
    const topUp = cover - free;
    log(`Bonding agent ${agentId}: ${money(topUp)} (it had ${money(free)} free)`);
    await send(owner, usdc, erc20Abi, 'approve', [bond, topUp]);
    await send(owner, bond, artifacts.AgentBond.abi, 'deposit', [agentId, topUp]);
  }

  const { timestamp } = await publicClient.getBlock();
  const quote = newQuote({
    agentId,
    amount,
    bondCover: cover,
    deadline: timestamp + 3600n,
    expiry: timestamp + 600n,
    terms: termsHash({ task: 'arrha smoke test', at: String(timestamp) }),
  });
  const chainId = await publicClient.getChainId();
  const signature = await signQuote(owner.account, { chainId, escrow, quote });
  const trust = await checkTrust(publicClient, { bond, quote, buyer: buyer.account.address });
  log(`Quote: ${money(amount)} job, ${money(cover)} cover; trust check ${trust.ok ? 'passed' : `failed: ${trust.reasons.join('; ')}`}`);
  if (!trust.ok) throw new Error('trust check failed');

  const jobId = await openJob({ walletClient: buyer, publicClient, escrow, paymentToken: usdc, quote, signature });
  log(`Job ${jobId} opened`);
  await send(owner, escrow, artifacts.AgentEscrow.abi, 'submit', [jobId, termsHash({ result: 'ok' })]);
  log(`Job ${jobId} submitted`);
  await send(buyer, escrow, artifacts.AgentEscrow.abi, 'release', [jobId]);
  log(`Job ${jobId} released`);

  const report = await agentRiskReport(publicClient, { escrow, bond, agentId, fromBlock: BigInt(deployment.AgentEscrow.block) });
  log(`Agent ${agentId}: score ${report.score}/100, ${report.band} risk, ${report.metrics.jobs} job(s) on record`);
  for (const line of report.explanation) log(`  - ${line}`);
  for (const f of report.flags) log(`  ${f.points}  ${f.reason}`);
  return { jobId, report };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const need = (k) => env[k] ?? (console.error(`set ${k}`), process.exit(1));
  const chain = env.CHAIN === 'base' ? base : baseSepolia;
  const deployment = JSON.parse(readFileSync(new URL(`../deployments/${chain === base ? 'base' : 'base-sepolia'}.json`, import.meta.url)));
  const transport = http(env.RPC_URL);
  const publicClient = createPublicClient({ chain, transport });
  const wallet = (key) => createWalletClient({ chain, transport, account: privateKeyToAccount(key) });
  await runSmoke({
    publicClient,
    owner: wallet(need('OWNER_KEY')),
    buyer: wallet(need('BUYER_KEY')),
    deployment,
    agentId: BigInt(need('AGENT_ID')),
    amount: parseUnits(env.JOB_USD ?? '1', 6),
    cover: parseUnits(env.COVER_USD ?? '2', 6),
  });
}
