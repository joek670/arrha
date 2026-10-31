// Arrha SDK: the client side of bonded agent payments, built on viem.
//
// Provider agent: sign a quote, attach it to an x402 402 response.
// Buyer agent: read the quote from the 402 response, check the provider's
// bond, open the job in escrow.
import { erc20Abi, hashTypedData, keccak256, parseAbi, parseEventLogs, parseSignature, stringToHex, toHex, zeroAddress } from 'viem';

export const QUOTE_TYPES = {
  Quote: [
    { name: 'agentId', type: 'uint256' },
    { name: 'buyer', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'bondCover', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'terms', type: 'bytes32' },
    { name: 'policy', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
};

export const ANY_BUYER = '0x0000000000000000000000000000000000000000';
export const NO_POLICY = '0x0000000000000000000000000000000000000000';

/// The x402 PaymentRequirements `extra` key Arrha quotes travel under.
export const X402_EXTRA_KEY = 'arrha';

/// Errors `open` can revert with, from AgentEscrow and the AgentBond it calls,
/// so failures decode to a name instead of a bare selector.
const openErrors = parseAbi([
  'error BadQuote(string reason)',
  'error BadSignature()',
  'error PolicyRejected(address policy)',
  'error NotSlasher()',
  'error InsufficientFreeBond(uint256 free, uint256 wanted)',
  'error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)',
  'error WalletLimitExceeded(uint256 allowed, uint256 wanted)',
  'error ERC721NonexistentToken(uint256 tokenId)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
]);

export const escrowAbi = [
  ...openErrors,
  {
    type: 'function',
    name: 'open',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'q', type: 'tuple', components: QUOTE_TYPES.Quote },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'jobId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'openWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'q', type: 'tuple', components: QUOTE_TYPES.Quote },
      { name: 'signature', type: 'bytes' },
      { name: 'buyer', type: 'address' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [{ name: 'jobId', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'JobOpened',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'bondCover', type: 'uint256', indexed: false },
      { name: 'terms', type: 'bytes32', indexed: false },
    ],
  },
];

export const policyAbi = parseAbi(['function isAllowed(address account) view returns (bool)']);
const registryAbi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
]);

export const bondAbi = [
  {
    type: 'function',
    name: 'identityRegistry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'freeBond',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'bonds',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      { name: 'total', type: 'uint256' },
      { name: 'locked', type: 'uint256' },
      { name: 'pending', type: 'uint256' },
      { name: 'unlockAt', type: 'uint64' },
    ],
  },
];

function randomSalt() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/// Build a quote. Times are unix seconds; amounts are token base units.
/// `policy` is an IAccountPolicy contract the buyer must pass, such as a
/// sanctions screen; leave it out for an open quote.
export function newQuote({ agentId, amount, bondCover = 0n, deadline, expiry, terms, buyer = ANY_BUYER, policy = NO_POLICY, salt = randomSalt() }) {
  return {
    agentId: BigInt(agentId),
    buyer,
    amount: BigInt(amount),
    bondCover: BigInt(bondCover),
    deadline: BigInt(deadline),
    expiry: BigInt(expiry),
    terms,
    policy,
    salt,
  };
}

export function quoteTypedData({ chainId, escrow, quote }) {
  return {
    domain: { name: 'ArrhaEscrow', version: '1', chainId, verifyingContract: escrow },
    types: QUOTE_TYPES,
    primaryType: 'Quote',
    message: quote,
  };
}

/// Sign as the agent's owner. `signer` is a viem Account or a WalletClient.
export function signQuote(signer, { chainId, escrow, quote }) {
  return signer.signTypedData(quoteTypedData({ chainId, escrow, quote }));
}

// ------------------------------------------------------------------- x402

/// The `extra.arrha` object a provider adds to its x402 PaymentRequirements,
/// so a buyer can choose bonded escrow instead of a plain transfer.
/// Bigints become decimal strings, since x402 bodies are JSON.
export function toX402Extra({ chainId, escrow, bond, quote, signature }) {
  return {
    [X402_EXTRA_KEY]: {
      version: 1,
      chainId,
      escrow,
      bond,
      signature,
      quote: Object.fromEntries(Object.entries(quote).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
    },
  };
}

/// Read an Arrha offer back out of x402 PaymentRequirements. Returns null
/// when the provider didn't offer one.
export function fromX402Requirements(requirements) {
  const offer = requirements?.extra?.[X402_EXTRA_KEY];
  if (!offer || offer.version !== 1) return null;
  const q = offer.quote;
  return {
    chainId: offer.chainId,
    escrow: offer.escrow,
    bond: offer.bond,
    signature: offer.signature,
    quote: newQuote({ ...q, salt: q.salt }),
  };
}

// ------------------------------------------------------------------ buyer

/// Decide whether to accept a quote, before paying gas to open it.
///
/// - The cover is only real if the agent has that much free bond right now;
///   `open` locks it.
/// - `buyer`: the address that will open the job, checked against the
///   provider's quote policy (if any), which `open` would otherwise reject.
/// - `screen`: the buyer's own IAccountPolicy, applied to the provider agent's
///   owner and to its ERC-8004 agent wallet (which is paid) if it has one.
export async function checkTrust(publicClient, { bond, quote, minCoverBps = 0, buyer, screen }) {
  const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
  const free = await read(bond, bondAbi, 'freeBond', [quote.agentId]);
  const required = (quote.amount * BigInt(minCoverBps)) / 10_000n;
  const reasons = [];
  if (quote.bondCover < required) reasons.push(`cover ${quote.bondCover} is below the ${minCoverBps} bps this buyer wants (${required})`);
  if (free < quote.bondCover) reasons.push(`agent has ${free} free bond, quote promises ${quote.bondCover}`);
  if (buyer && quote.policy !== NO_POLICY && !(await read(quote.policy, policyAbi, 'isAllowed', [buyer]))) {
    reasons.push(`buyer ${buyer} doesn't pass the provider's policy ${quote.policy}`);
  }
  if (screen) {
    const registry = await read(bond, bondAbi, 'identityRegistry');
    const owner = await read(registry, registryAbi, 'ownerOf', [quote.agentId]);
    // Registries without agent wallets revert here; the owner is then paid.
    const wallet = await read(registry, registryAbi, 'getAgentWallet', [quote.agentId]).catch(() => zeroAddress);
    const parties = [['provider owner', owner]];
    if (wallet !== zeroAddress && wallet.toLowerCase() !== owner.toLowerCase()) parties.push(['provider agent wallet', wallet]);
    for (const [role, account] of parties) {
      if (!(await read(screen, policyAbi, 'isAllowed', [account]))) reasons.push(`${role} ${account} doesn't pass policy ${screen}`);
    }
  }
  return { ok: reasons.length === 0, free, required, reasons };
}

/// Approve the payment and open the job. Returns the job ID.
export async function openJob({ walletClient, publicClient, escrow, paymentToken, quote, signature, txOptions = {} }) {
  const approve = await walletClient.writeContract({ address: paymentToken, abi: erc20Abi, functionName: 'approve', args: [escrow, quote.amount], ...txOptions });
  await publicClient.waitForTransactionReceipt({ hash: approve });
  const hash = await walletClient.writeContract({ address: escrow, abi: escrowAbi, functionName: 'open', args: [quote, signature], ...txOptions });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [opened] = parseEventLogs({ abi: escrowAbi, eventName: 'JobOpened', logs: receipt.logs });
  return opened.args.jobId;
}

// --------------------------------------------------------------- gasless

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const tokenDomainAbi = parseAbi(['function name() view returns (string)', 'function version() view returns (string)']);

/// The buyer's half of a gasless open: a USDC (EIP-3009) authorisation that
/// pays the escrow exactly the quote's amount. Its nonce is the quote's
/// EIP-712 digest, so it can pay for this quote and nothing else. `buyer` is
/// a viem Account; `validBefore` is a unix time.
export async function signOpenAuthorization(buyer, { publicClient, paymentToken, escrow, quote, validAfter = 0n, validBefore }) {
  const chainId = await publicClient.getChainId();
  const read = (functionName) => publicClient.readContract({ address: paymentToken, abi: tokenDomainAbi, functionName });
  const [name, version] = await Promise.all([read('name'), read('version')]);
  const nonce = hashTypedData(quoteTypedData({ chainId, escrow, quote }));
  const message = { from: buyer.address, to: escrow, value: quote.amount, validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce };
  const signature = await buyer.signTypedData({
    domain: { name, version, chainId, verifyingContract: paymentToken },
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message,
  });
  const { r, s, v } = parseSignature(signature);
  return { buyer: buyer.address, validAfter: message.validAfter, validBefore: message.validBefore, v: Number(v), r, s };
}

/// Relay a gasless open. Anyone can send it (a facilitator, the provider):
/// the buyer sends no transaction and needs no ETH. Returns the job ID.
export async function openJobWithAuthorization({ walletClient, publicClient, escrow, quote, signature, authorization, txOptions = {} }) {
  const { buyer, validAfter, validBefore, v, r, s } = authorization;
  const hash = await walletClient.writeContract({
    address: escrow,
    abi: escrowAbi,
    functionName: 'openWithAuthorization',
    args: [quote, signature, buyer, validAfter, validBefore, v, r, s],
    ...txOptions,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const [opened] = parseEventLogs({ abi: escrowAbi, eventName: 'JobOpened', logs: receipt.logs });
  return opened.args.jobId;
}

/// Hash a job spec into the quote's `terms`, so both sides can prove what
/// was agreed. Any JSON-serialisable spec works; keys are sorted first.
export function termsHash(spec) {
  const canonical = JSON.stringify(spec, Object.keys(flatten(spec)).sort());
  return keccak256(stringToHex(canonical));
}

function flatten(value, out = {}) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out[k] = true;
      flatten(v, out);
    }
  }
  return out;
}
