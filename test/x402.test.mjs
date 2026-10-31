// The x402 paywall and fetch wrapper, over real HTTP on localhost, against
// the in-process chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { keccak256, toHex } from 'viem';
import { read } from './chain.mjs';
import { setup, usd, tx } from './fixture.mjs';
import { checkTrust, fromX402Requirements } from '../sdk/arrha.mjs';
import { arrhaFetch, arrhaPaywall, paymentResponse } from '../sdk/x402.mjs';

async function serve(t, options = {}) {
  const handler = arrhaPaywall({
    publicClient: t.chain.publicClient,
    walletClient: t.provider.client,
    signer: t.provider.account,
    escrow: t.sys.escrow,
    bond: t.sys.bond,
    asset: t.sys.usdc,
    network: 'base-sepolia',
    agentId: t.agentId,
    price: usd(2),
    cover: usd(5),
    deliverWithin: 3600,
    produce: async () => ({ body: { translation: 'bonjour' } }),
    txOptions: tx,
    ...options,
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.close = () => new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${server.address().port}/translate`;
}

const buyerOptions = (t, extra = {}) => ({ publicClient: t.chain.publicClient, walletClient: t.buyer.client, txOptions: tx, ...extra });

test('an unpaid request gets a 402 offering a bonded job the buyer can check', async () => {
  const t = await setup();
  const url = await serve(t);
  try {
    const res = await fetch(url);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.accepts[0].scheme, 'arrha');
    const offer = fromX402Requirements(body.accepts[0]);
    assert.equal(offer.quote.amount, usd(2));
    assert.equal(offer.quote.bondCover, usd(5));
    assert.equal((await checkTrust(t.chain.publicClient, { bond: offer.bond, quote: offer.quote })).ok, true);
  } finally {
    await t.close();
  }
});

test('the buyer pays through escrow; the server serves and submits proof of delivery', async () => {
  const t = await setup();
  const url = await serve(t);
  try {
    const { response, jobId } = await arrhaFetch(url, {}, buyerOptions(t));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { translation: 'bonjour' });
    const receipt = paymentResponse(response);
    assert.equal(receipt.jobId, jobId.toString());
    assert.equal(receipt.result, keccak256(toHex(text)));
    const [, , , status] = await read(t.chain, t.sys.escrow, 'AgentEscrow', 'jobs', [jobId]);
    assert.equal(status, 2); // Submitted: the provider is paid once the buyer releases
    assert.equal((await t.bondOf()).locked, usd(5));
  } finally {
    await t.close();
  }
});

test('gasless: the buyer only signs, a relayer opens the job', async () => {
  const t = await setup();
  const url = await serve(t);
  try {
    const { response } = await arrhaFetch(url, {}, { publicClient: t.chain.publicClient, buyer: t.buyer.account, gasless: true, relayerClient: t.chain.wallet(30).client, txOptions: tx });
    assert.equal(response.status, 200);
    assert.equal(await read(t.chain, t.sys.usdc, 'MockUSDC', 'allowance', [t.buyer.address, t.sys.escrow]), 0n);
  } finally {
    await t.close();
  }
});

test("a job is served once, and only if it was opened from this server's quote", async () => {
  const t = await setup();
  const url = await serve(t);
  try {
    const { response, jobId } = await arrhaFetch(url, {}, buyerOptions(t));
    assert.equal(response.status, 200);
    const replay = (id) => fetch(url, { headers: { 'x-payment': Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'arrha', payload: { jobId: id.toString() } })).toString('base64') } });
    const again = await replay(jobId);
    assert.equal(again.status, 402);
    assert.match((await again.json()).error, /already been served/);

    // A job the provider signed for elsewhere wasn't issued by this server.
    const elsewhere = await t.open(t.quote());
    const foreign = await replay(elsewhere);
    assert.equal(foreign.status, 402);
    assert.match((await foreign.json()).error, /not opened from a quote this server issued/);
  } finally {
    await t.close();
  }
});

test('a buyer refuses an offer that fails its own checks', async () => {
  const t = await setup();
  const url = await serve(t);
  try {
    await assert.rejects(arrhaFetch(url, {}, buyerOptions(t, { minCoverBps: 50_000 })), /refusing the offer/);
  } finally {
    await t.close();
  }
});
