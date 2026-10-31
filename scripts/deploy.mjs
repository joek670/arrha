// Deploys AgentBond and AgentEscrow to a live network (Base Sepolia by
// default), proposes the escrow as a slasher, and records the addresses in
// deployments/<network>.json. Run `npm run build` first.
//
//   PRIVATE_KEY=0x... node scripts/deploy.mjs
//
// Optional: CHAIN=base (mainnet), RPC_URL (default: the chain's public RPC),
// IDENTITY_REGISTRY, USDC, ARBITER, TREASURY, OWNER, UNBONDING_SECONDS,
// REVIEW_SECONDS, ARBITRATION_SECONDS, FEE_BPS, MAX_JOB_USD (largest job the
// escrow accepts; mainnet defaults to 100, testnet to no cap), and
// SANCTIONS_LIST (an on-chain sanctions list to wrap in a SanctionsPolicy
// that providers can name in their quotes).
// Defaults make the deployer the owner, arbiter and treasury: fine for a
// testnet, not for real money. On a testnet, UNBONDING_SECONDS=3600 saves
// waiting a week before the escrow can lock bond.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, getAddress, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

const artifacts = JSON.parse(readFileSync(new URL('../build/contracts.json', import.meta.url)));

/// Deploys and configures everything; returns the deployment record.
export async function runDeploy({ publicClient, wallet, config, log = console.log }) {
  const me = wallet.account.address;
  const record = { chainId: await publicClient.getChainId(), deployer: me, usdc: config.usdc, identityRegistry: config.registry };

  async function deploy(name, args) {
    const hash = await wallet.deployContract({ abi: artifacts[name].abi, bytecode: artifacts[name].bytecode, args });
    const { contractAddress, blockNumber, status } = await publicClient.waitForTransactionReceipt({ hash });
    if (status !== 'success') throw new Error(`deploying ${name} failed in ${hash}`);
    log(`${name}: ${contractAddress}`);
    record[name] = { address: contractAddress, block: Number(blockNumber) };
    return contractAddress;
  }
  async function send(address, contract, functionName, args) {
    const { request } = await publicClient.simulateContract({ account: wallet.account, address, abi: artifacts[contract].abi, functionName, args });
    const hash = await wallet.writeContract(request);
    const { status } = await publicClient.waitForTransactionReceipt({ hash });
    if (status !== 'success') throw new Error(`${contract}.${functionName} failed in ${hash}`);
  }

  // Both contracts start owned by the deployer so it can configure them.
  const bond = await deploy('AgentBond', [config.usdc, config.registry, config.unbonding, me]);
  const escrow = await deploy('AgentEscrow', [config.usdc, bond, config.review, config.arbitration, config.arbiter, config.treasury, config.feeBps, me]);
  await send(bond, 'AgentBond', 'proposeSlasher', [escrow]);
  const activeAt = await publicClient.readContract({ address: bond, abi: artifacts.AgentBond.abi, functionName: 'slasherActiveAt', args: [escrow] });
  record.slasherActiveAt = new Date(Number(activeAt) * 1000).toISOString();
  log(`The escrow can lock bond from ${record.slasherActiveAt}.`);

  if (config.maxJob > 0n) {
    await send(escrow, 'AgentEscrow', 'setMaxJobAmount', [config.maxJob]);
    log(`Jobs capped at ${config.maxJob} base units.`);
  }
  if (config.sanctionsList) await deploy('SanctionsPolicy', [config.sanctionsList]);

  // Then hand both to OWNER: a multisig, for real money.
  if (getAddress(config.owner) !== getAddress(me)) {
    await send(bond, 'AgentBond', 'transferOwnership', [config.owner]);
    await send(escrow, 'AgentEscrow', 'transferOwnership', [config.owner]);
    log(`Ownership of both contracts moved to ${config.owner}`);
  }
  record.owner = getAddress(config.owner);
  return record;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const need = (k) => env[k] ?? (console.error(`set ${k}`), process.exit(1));
  const chain = env.CHAIN === 'base' ? base : baseSepolia;
  const mainnet = chain === base;
  const account = privateKeyToAccount(need('PRIVATE_KEY'));
  const config = {
    // Circle's USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
    usdc: env.USDC ?? (mainnet ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
    // ERC-8004 IdentityRegistry, the same address on every mainnet and on
    // every testnet: https://github.com/erc-8004/erc-8004-contracts
    registry: env.IDENTITY_REGISTRY ?? (mainnet ? '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' : '0x8004A818BFB912233c491871b3d84c89A494BD9e'),
    owner: env.OWNER ?? account.address,
    arbiter: env.ARBITER ?? account.address,
    treasury: env.TREASURY ?? account.address,
    unbonding: BigInt(env.UNBONDING_SECONDS ?? 7 * 86400),
    review: BigInt(env.REVIEW_SECONDS ?? 86400),
    arbitration: BigInt(env.ARBITRATION_SECONDS ?? 3 * 86400),
    feeBps: Number(env.FEE_BPS ?? 50),
    maxJob: parseUnits(env.MAX_JOB_USD ?? (mainnet ? '100' : '0'), 6),
    sanctionsList: env.SANCTIONS_LIST,
  };
  const transport = http(env.RPC_URL); // undefined: the chain's public RPC
  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account });

  console.log(`Deploying to ${chain.name} from ${account.address}`);
  const record = { network: chain.name, ...(await runDeploy({ publicClient, wallet, config })) };
  const out = new URL(`../deployments/${mainnet ? 'base' : 'base-sepolia'}.json`, import.meta.url);
  mkdirSync(new URL('.', out), { recursive: true });
  writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
  console.log(`Recorded in ${out.pathname}`);
  console.log('Next: OWNER_KEY=0x... BUYER_KEY=0x... AGENT_ID=... node scripts/smoke.mjs');
}
