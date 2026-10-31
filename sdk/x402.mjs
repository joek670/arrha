// x402 integration: a paywall for providers and a fetch wrapper for buyers.
//
// The provider's server answers an unpaid request with HTTP 402 and an x402
// payment requirement of scheme "arrha", carrying a signed Arrha quote. The
// buyer checks the provider's bond, opens the job in escrow, and repeats the
// request with an X-PAYMENT header naming the job. The server checks the job
// on-chain and that it came from a quote this server issued, serves the
// response, and submits a hash of it as the delivered result.
import { keccak256, parseAbi, toHex } from 'viem';
import {
  checkTrust,
  fromX402Requirements,
  newQuote,
  openJob,
  openJobWithAuthorization,
  signOpenAuthorization,
  signQuote,
  termsHash,
  toX402Extra,
} from './arrha.mjs';

export const X402_SCHEME = 'arrha';
const OPEN = 1;

const escrowReadAbi = parseAbi([
  'function jobs(uint256) view returns (address buyer, uint40 deadline, uint40 windowEndsAt, uint8 status, uint128 amount, uint112 bondCover, uint16 feeBps, uint256 agentId)',
  'function submit(uint256 jobId, bytes32 result)',
  'event JobOpened(uint256 indexed jobId, uint256 indexed agentId, address indexed buyer, uint256 amount, uint256 bondCover, bytes32 terms)',
]);

const encodeHeader = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const decodeHeader = (header) => JSON.parse(Buffer.from(header, 'base64').toString('utf8'));

/// A Node `http` request handler for a provider. Unpaid requests get a 402
/// offering a bonded job; paid ones are served by `produce(req, job)`, which
/// returns `{ status?, headers?, body }`, and the body's hash is submitted
/// on-chain as the result.
///
/// - `signer`: a viem Account that acts for the agent (owner or agent wallet),
///   used to sign quotes.
/// - `walletClient`: sends the submit transaction, from an address that acts
///   for the agent.
/// - `price`, `cover`: token base units. `deliverWithin`, `quoteTtl`: seconds.
/// - `fromBlock`: where to look for JobOpened events; the escrow's deployment
///   block on a real network.
export function arrhaPaywall({ publicClient, walletClient, signer, escrow, bond, asset, network, agentId, price, cover = 0n, deliverWithin = 600, quoteTtl = 300, description = '', produce, fromBlock = 0n, txOptions = {} }) {
  const issued = new Map(); // terms hash -> quote, for quotes not yet used
  const serving = new Set(); // job IDs being or already answered

  async function offer(req, res) {
    const { timestamp } = await publicClient.getBlock();
    for (const [terms, q] of issued) if (q.expiry < timestamp) issued.delete(terms);
    const quote = newQuote({
      agentId,
      amount: price,
      bondCover: cover,
      deadline: timestamp + BigInt(deliverWithin),
      expiry: timestamp + BigInt(quoteTtl),
      terms: termsHash({ method: req.method, url: req.url, nonce: toHex(crypto.getRandomValues(new Uint8Array(16))) }),
    });
    const chainId = await publicClient.getChainId();
    const signature = await signQuote(signer, { chainId, escrow, quote });
    issued.set(quote.terms, quote);
    send(res, 402, {
      x402Version: 1,
      error: 'payment required',
      accepts: [
        {
          scheme: X402_SCHEME,
          network,
          maxAmountRequired: price.toString(),
          resource: req.url,
          description,
          mimeType: 'application/json',
          payTo: escrow,
          maxTimeoutSeconds: deliverWithin,
          asset,
          extra: toX402Extra({ chainId, escrow, bond, quote, signature }),
        },
      ],
    });
  }

  async function verify(jobId) {
    const [, , , status, amount, bondCover, , jobAgent] = await publicClient.readContract({ address: escrow, abi: escrowReadAbi, functionName: 'jobs', args: [jobId] });
    if (status !== OPEN) return 'the job is not open';
    if (jobAgent !== BigInt(agentId)) return 'the job is for another agent';
    const [opened] = await publicClient.getContractEvents({ address: escrow, abi: escrowReadAbi, eventName: 'JobOpened', args: { jobId }, fromBlock });
    const quote = opened && issued.get(opened.args.terms);
    if (!quote) return 'the job was not opened from a quote this server issued';
    if (amount < quote.amount || bondCover < quote.bondCover) return 'the job pays or covers less than quoted';
    issued.delete(opened.args.terms);
    return null;
  }

  return async function handle(req, res) {
    let jobId;
    try {
      const header = req.headers['x-payment'];
      if (!header) return await offer(req, res);
      const payment = decodeHeader(header);
      if (payment.scheme !== X402_SCHEME) return await offer(req, res);
      const requested = BigInt(payment.payload.jobId);
      // Claimed before the first await, so two requests can't serve one job.
      if (serving.has(requested)) return send(res, 402, { x402Version: 1, error: 'this job has already been served', accepts: [] });
      serving.add(requested);
      jobId = requested;
      const problem = await verify(jobId);
      if (problem) {
        serving.delete(jobId);
        jobId = undefined;
        return send(res, 402, { x402Version: 1, error: problem, accepts: [] });
      }

      const out = await produce(req, { jobId });
      const body = typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
      const result = keccak256(toHex(body));
      const hash = await walletClient.writeContract({ address: escrow, abi: escrowReadAbi, functionName: 'submit', args: [jobId, result], ...txOptions });
      await publicClient.waitForTransactionReceipt({ hash });
      res.writeHead(out.status ?? 200, {
        'content-type': 'application/json',
        ...out.headers,
        'x-payment-response': encodeHeader({ success: true, scheme: X402_SCHEME, jobId: jobId.toString(), result, transaction: hash }),
      });
      res.end(body);
    } catch (err) {
      // Let the buyer retry: a job that wasn't delivered must not be stuck.
      if (jobId !== undefined) serving.delete(jobId);
      send(res, 500, { error: err.shortMessage ?? err.message });
    }
  };
}

function send(res, status, json) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
}

/// fetch(), for a buyer agent: when the server answers 402 with an Arrha
/// offer, check the provider, open the bonded job and repeat the request.
/// Returns `{ response, jobId }`; `jobId` is undefined if no job was opened.
///
/// - `walletClient` opens the job (the buyer pays), unless `gasless` is set:
///   then `buyer` (a viem Account) signs a USDC authorisation and
///   `relayerClient` sends it.
/// - `minCoverBps`, `screen`: passed to checkTrust; a failed check throws.
export async function arrhaFetch(url, init = {}, { publicClient, walletClient, buyer, gasless = false, relayerClient, minCoverBps = 0, screen, txOptions = {}, fetch = globalThis.fetch } = {}) {
  const first = await fetch(url, init);
  if (first.status !== 402) return { response: first };
  const required = await first.clone().json().catch(() => null);
  const accepted = required?.accepts?.find((r) => r.scheme === X402_SCHEME);
  const offer = accepted && fromX402Requirements(accepted);
  if (!offer) return { response: first };

  const buyerAddress = gasless ? buyer.address : walletClient.account.address;
  const trust = await checkTrust(publicClient, { bond: offer.bond, quote: offer.quote, minCoverBps, buyer: buyerAddress, screen });
  if (!trust.ok) throw new Error(`refusing the offer: ${trust.reasons.join('; ')}`);

  let jobId;
  if (gasless) {
    const { timestamp } = await publicClient.getBlock();
    const authorization = await signOpenAuthorization(buyer, { publicClient, paymentToken: accepted.asset, escrow: offer.escrow, quote: offer.quote, validBefore: timestamp + 600n });
    jobId = await openJobWithAuthorization({ walletClient: relayerClient, publicClient, escrow: offer.escrow, quote: offer.quote, signature: offer.signature, authorization, txOptions });
  } else {
    jobId = await openJob({ walletClient, publicClient, escrow: offer.escrow, paymentToken: accepted.asset, quote: offer.quote, signature: offer.signature, txOptions });
  }

  const headers = { ...init.headers, 'x-payment': encodeHeader({ x402Version: 1, scheme: X402_SCHEME, network: accepted.network, payload: { jobId: jobId.toString() } }) };
  const response = await fetch(url, { ...init, headers });
  return { response, jobId };
}

/// Read the X-PAYMENT-RESPONSE header a paywall sends with a served response.
export function paymentResponse(response) {
  const header = response.headers.get('x-payment-response');
  return header ? decodeHeader(header) : null;
}
