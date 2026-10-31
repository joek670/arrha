// Gasless funding: the buyer signs one USDC (EIP-3009) authorisation and
// anyone relays it. No approve, no transaction from the buyer, no ETH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploy, read, write } from './chain.mjs';
import { setup, usd, tx } from './fixture.mjs';
import { signOpenAuthorization, openJobWithAuthorization } from '../sdk/arrha.mjs';

async function authorise(t, { quote = t.quote(), buyer = t.buyer, validBefore = BigInt(t.chain.now() + 3600) } = {}) {
  const signature = await t.sign(quote);
  const authorization = await signOpenAuthorization(buyer.account, {
    publicClient: t.chain.publicClient,
    paymentToken: t.sys.usdc,
    escrow: t.sys.escrow,
    quote,
    validBefore,
  });
  return { quote, signature, authorization };
}

const relay = (t, { quote, signature, authorization }, relayer = t.chain.wallet(30)) =>
  openJobWithAuthorization({ walletClient: relayer.client, publicClient: t.chain.publicClient, escrow: t.sys.escrow, quote, signature, authorization, txOptions: tx });

test("a relayer opens the job with the buyer's one signature: no approve, no buyer transaction", async () => {
  const t = await setup();
  const before = await t.balance(t.buyer.address);
  const jobId = await relay(t, await authorise(t));
  assert.equal(jobId, 1n);
  const [buyer] = await read(t.chain, t.sys.escrow, 'AgentEscrow', 'jobs', [jobId]);
  assert.equal(buyer, t.buyer.address);
  assert.equal(before - (await t.balance(t.buyer.address)), usd(10));
  assert.equal(await read(t.chain, t.sys.usdc, 'MockUSDC', 'allowance', [t.buyer.address, t.sys.escrow]), 0n);
  assert.equal((await t.bondOf()).locked, usd(20));
});

test('the authorisation pays for its own quote and nothing else', async () => {
  const t = await setup();
  const { authorization } = await authorise(t);
  const other = t.quote();
  await assert.rejects(relay(t, { quote: other, signature: await t.sign(other), authorization }), /invalid signature/);
});

test('it cannot be replayed, used late, or taken by someone else', async () => {
  const t = await setup();
  const a = await authorise(t);
  await relay(t, a);
  await assert.rejects(relay(t, a), /used/);

  const late = await authorise(t, { validBefore: BigInt(t.chain.now() + 10) });
  t.chain.advance(11);
  await assert.rejects(relay(t, late), /authorization is expired/);

  // Calling the token directly fails: only the escrow, the payee, may redeem it.
  const fresh = await authorise(t);
  const { buyer, validAfter, validBefore, v, r, s } = fresh.authorization;
  const nonce = await read(t.chain, t.sys.escrow, 'AgentEscrow', 'quoteDigest', [fresh.quote]);
  await assert.rejects(
    write(t.chain, t.chain.wallet(31), t.sys.usdc, 'MockUSDC', 'receiveWithAuthorization', [buyer, t.sys.escrow, fresh.quote.amount, validAfter, validBefore, nonce, v, r, s]),
    /caller must be the payee/,
  );
});

test('self-dealing and policy checks apply to the authorising buyer, whoever relays', async () => {
  const t = await setup();
  await write(t.chain, t.provider, t.sys.usdc, 'MockUSDC', 'mint', [t.provider.address, usd(100)]);
  await assert.rejects(relay(t, await authorise(t, { buyer: t.provider })), /self-dealing/);

  const list = await deploy(t.chain, t.sys.admin, 'MockSanctionsList');
  const policy = await deploy(t.chain, t.sys.admin, 'SanctionsPolicy', [list]);
  await write(t.chain, t.sys.admin, list, 'MockSanctionsList', 'set', [t.buyer.address, true]);
  await assert.rejects(relay(t, await authorise(t, { quote: t.quote({ policy }) })), /PolicyRejected/);
});
