// Shared setup: a deployed system with one bonded provider agent and one
// funded buyer, plus helpers the tests use to drive it.
import { parseUnits } from 'viem';
import { createChain, deployAll, write, read, CHAIN_ID } from './chain.mjs';
import { newQuote, signQuote, openJob, termsHash } from '../sdk/arrha.mjs';

export const usd = (n) => parseUnits(String(n), 6);
export const DAY = 86400;
export const tx = { gas: 30_000_000n, gasPrice: 0n };

/// A deployed system with one bonded provider agent and one funded buyer.
export async function setup({ bond = 100, feeBps = 50, registry } = {}) {
  const chain = await createChain();
  const sys = await deployAll(chain, { feeBps, registry });
  const provider = chain.wallet(10);
  const buyer = chain.wallet(11);
  await write(chain, provider, sys.registry, 'MockIdentityRegistry', 'register');
  const agentId = 1n;
  for (const w of [provider, buyer]) await write(chain, w, sys.usdc, 'MockUSDC', 'mint', [w.address, usd(1000)]);
  if (bond > 0) {
    await write(chain, provider, sys.usdc, 'MockUSDC', 'approve', [sys.bond, usd(bond)]);
    await write(chain, provider, sys.bond, 'AgentBond', 'deposit', [agentId, usd(bond)]);
  }
  const balance = (who) => read(chain, sys.usdc, 'MockUSDC', 'balanceOf', [who]);
  const bondOf = async () => {
    const [total, locked, pending] = await read(chain, sys.bond, 'AgentBond', 'bonds', [agentId]);
    return { total, locked, pending };
  };
  const quote = (over = {}) =>
    newQuote({
      agentId,
      amount: usd(10),
      bondCover: usd(20),
      deadline: chain.now() + DAY,
      expiry: chain.now() + 600,
      terms: termsHash({ task: 'summarise', url: 'https://example.com' }),
      ...over,
    });
  const sign = (q, signer = provider.account, escrow = sys.escrow) => signQuote(signer, { chainId: CHAIN_ID, escrow, quote: q });
  const open = async (q, sig, who = buyer) =>
    openJob({ walletClient: who.client, publicClient: chain.publicClient, escrow: sys.escrow, paymentToken: sys.usdc, quote: q, signature: sig ?? (await sign(q)), txOptions: tx });
  return { chain, sys, provider, buyer, agentId, balance, bondOf, quote, sign, open };
}

