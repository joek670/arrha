// An in-process EVM behind a minimal JSON-RPC, so viem (and the SDK) run
// against it exactly as they would against Base. No node, no download.
//
// Supports what viem needs to deploy, read, write, wait for receipts and
// query event logs, from JSON-RPC accounts (eth_sendTransaction) or local
// ones that sign (eth_sendRawTransaction).
// Transactions skip nonces and gas fees, and unsigned ones trust `from`.
import { createVM } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { createTxFromRLP } from '@ethereumjs/tx';
import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { createAddressFromString, bytesToHex, hexToBytes } from '@ethereumjs/util';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, custom, defineChain, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const CHAIN_ID = 31337;
const hex = (n) => toHex(n);

function blockTag(tag, latest) {
  if (tag === undefined || ['latest', 'pending', 'safe', 'finalized'].includes(tag)) return latest;
  if (tag === 'earliest') return 0;
  return Number(BigInt(tag));
}

/// eth_getLogs filtering: address (one or many), block range, and topics where
/// null matches anything and an array matches any of its entries.
function matchesFilter(log, { address, fromBlock, toBlock, topics = [] }, latest) {
  const n = Number(BigInt(log.blockNumber));
  if (n < blockTag(fromBlock, latest) || n > blockTag(toBlock, latest)) return false;
  if (address) {
    const wanted = [address].flat().map((a) => a.toLowerCase());
    if (!wanted.includes(log.address.toLowerCase())) return false;
  }
  return topics.every((t, i) => t === null || [t].flat().map((x) => x.toLowerCase()).includes(log.topics[i]?.toLowerCase()));
}

/// `onTransaction({ tx, result })` sees every committed transaction, with the
/// EVM's execution result (gas used, refund); scripts/gas.mjs uses it.
/// `unlimitedCodeSize` lifts EIP-170's 24,576-byte contract size limit, for
/// third-party contracts that exceed it.
export async function createChain({ start = 1_800_000_000, onTransaction, unlimitedCodeSize = false } = {}) {
  const common = new Common({ chain: { ...Mainnet, chainId: CHAIN_ID }, hardfork: Hardfork.Cancun });
  const vm = await createVM({ common, evmOpts: { allowUnlimitedContractSize: unlimitedCodeSize } });
  let now = start;
  let blockNumber = 1;
  const receipts = new Map();
  const allLogs = [];
  const blockTimes = new Map([[blockNumber, now]]);

  const block = () =>
    createBlock({ header: { number: BigInt(blockNumber), timestamp: BigInt(now), gasLimit: 60_000_000n, baseFeePerGas: 0n } }, { common });

  async function run({ from, to, data, value }) {
    return vm.evm.runCall({
      caller: createAddressFromString(from),
      to: to ? createAddressFromString(to) : undefined,
      data: hexToBytes(data ?? '0x'),
      value: value ? BigInt(value) : 0n,
      gasLimit: 30_000_000n,
      gasPrice: 0n,
      skipBalance: true,
      block: block(),
    });
  }

  function revertError(exec) {
    const err = new Error(`execution reverted (${exec.exceptionError.error})`);
    err.code = 3;
    err.data = bytesToHex(exec.returnValue ?? new Uint8Array());
    return err;
  }

  async function send(tx) {
    await vm.stateManager.checkpoint();
    const result = await run(tx);
    if (result.execResult.exceptionError) {
      await vm.stateManager.revert();
      throw revertError(result.execResult);
    }
    await vm.stateManager.commit();
    onTransaction?.({ tx, result });
    blockNumber += 1;
    blockTimes.set(blockNumber, now);
    const hash = keccak256(toHex(`tx-${blockNumber}`));
    const blockHash = keccak256(toHex(blockNumber));
    const receipt = {
      transactionHash: hash,
      transactionIndex: '0x0',
      blockHash,
      blockNumber: hex(blockNumber),
      from: tx.from,
      to: tx.to ?? null,
      contractAddress: result.createdAddress ? result.createdAddress.toString() : null,
      status: '0x1',
      type: '0x2',
      gasUsed: hex(result.execResult.executionGasUsed),
      cumulativeGasUsed: hex(result.execResult.executionGasUsed),
      effectiveGasPrice: '0x0',
      logsBloom: '0x' + '00'.repeat(256),
      logs: (result.execResult.logs ?? []).map(([address, topics, data], i) => ({
        address: bytesToHex(address),
        topics: topics.map(bytesToHex),
        data: bytesToHex(data),
        logIndex: hex(i),
        transactionIndex: '0x0',
        transactionHash: hash,
        blockHash,
        blockNumber: hex(blockNumber),
        removed: false,
      })),
    };
    receipts.set(hash, receipt);
    allLogs.push(...receipt.logs);
    return hash;
  }

  async function request({ method, params = [] }) {
    switch (method) {
      case 'eth_chainId':
        return hex(CHAIN_ID);
      case 'eth_blockNumber':
        return hex(blockNumber);
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        return '0x0';
      case 'eth_estimateGas':
        return hex(30_000_000);
      case 'eth_getTransactionCount':
        return '0x0';
      case 'eth_getBlockByNumber': {
        // Every block keeps the time it was mined at.
        const n = blockTag(params[0], blockNumber);
        return {
          number: hex(n),
          hash: keccak256(toHex(n)),
          parentHash: keccak256(toHex(n - 1)),
          timestamp: hex(blockTimes.get(n) ?? now),
          baseFeePerGas: '0x0',
          gasLimit: hex(60_000_000),
          gasUsed: '0x0',
          transactions: [],
        };
      }
      case 'eth_call': {
        await vm.stateManager.checkpoint();
        try {
          const { execResult } = await run({ from: params[0].from ?? '0x' + '00'.repeat(20), ...params[0] });
          if (execResult.exceptionError) throw revertError(execResult);
          return bytesToHex(execResult.returnValue);
        } finally {
          await vm.stateManager.revert();
        }
      }
      case 'eth_sendRawTransaction': {
        const signed = createTxFromRLP(hexToBytes(params[0]), { common });
        return send({
          from: signed.getSenderAddress().toString(),
          to: signed.to?.toString(),
          data: bytesToHex(signed.data),
          value: hex(signed.value),
        });
      }
      case 'eth_sendTransaction':
        return send(params[0]);
      case 'eth_getLogs':
        return allLogs.filter((log) => matchesFilter(log, params[0], blockNumber));
      case 'eth_getTransactionReceipt':
        return receipts.get(params[0]) ?? null;
      case 'eth_getTransactionByHash': {
        const r = receipts.get(params[0]);
        return r && { hash: r.transactionHash, blockHash: r.blockHash, blockNumber: r.blockNumber, from: r.from, to: r.to, input: '0x', nonce: '0x0', value: '0x0', gas: '0x0', gasPrice: '0x0', type: '0x0', transactionIndex: '0x0', v: '0x0', r: '0x0', s: '0x0', chainId: hex(CHAIN_ID) };
      }
      default:
        throw new Error(`test chain: ${method} not supported`);
    }
  }

  const chain = defineChain({
    id: CHAIN_ID,
    name: 'arrha-test',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://localhost'] } },
  });
  const transport = custom({ request });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 1 });

  // Fixed keys so test signatures are deterministic. Never use these anywhere real.
  const wallet = (i) => {
    const account = privateKeyToAccount(keccak256(toHex(`arrha-test-key-${i}`)));
    return {
      account,
      address: account.address,
      // Sends through eth_sendTransaction with `from`; quotes are signed locally.
      client: createWalletClient({ chain, transport, account: account.address }),
      // Signs every transaction itself and sends it raw, as against a real network.
      signer: createWalletClient({ chain, transport, account }),
    };
  };

  return {
    publicClient,
    wallet,
    now: () => now,
    // Time passes the way it does on a real chain: with a new (empty) block.
    advance: (seconds) => {
      now += seconds;
      blockNumber += 1;
      blockTimes.set(blockNumber, now);
    },
  };
}

const artifacts = JSON.parse(readFileSync(new URL('../build/contracts.json', import.meta.url)));

// Every custom error from every contract, so an error bubbled up from a call
// into another contract (a token, the bond) still decodes to its name.
const allErrors = [
  ...new Map(
    Object.values(artifacts)
      .flatMap((a) => a.abi.filter((item) => item.type === 'error'))
      .map((e) => [`${e.name}(${e.inputs.map((i) => i.type).join(',')})`, e]),
  ).values(),
];
export const abi = (name) => [...artifacts[name].abi.filter((item) => item.type !== 'error'), ...allErrors];

export async function deploy(chain, from, name, args = []) {
  const { abi: contractAbi, bytecode } = artifacts[name];
  const hash = await from.client.deployContract({ abi: contractAbi, bytecode, args, gas: 30_000_000n, gasPrice: 0n });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress;
}

/// Deploys mocks plus the Arrha contracts, with the escrow approved as a slasher.
/// `registry` picks the identity mock: a plain ERC-721 registry, or
/// 'MockAgentRegistry' for one with ERC-8004 agent wallets.
export async function deployAll(chain, { unbonding = 7 * 86400, review = 86400, arbitration = 3 * 86400, feeBps = 50, registry: registryName = 'MockIdentityRegistry' } = {}) {
  const [admin, arbiter, treasury] = [chain.wallet(0), chain.wallet(1), chain.wallet(2)];
  const usdc = await deploy(chain, admin, 'MockUSDC');
  const registry = await deploy(chain, admin, registryName);
  const bond = await deploy(chain, admin, 'AgentBond', [usdc, registry, BigInt(unbonding), admin.address]);
  const escrow = await deploy(chain, admin, 'AgentEscrow', [usdc, bond, BigInt(review), BigInt(arbitration), arbiter.address, treasury.address, feeBps, admin.address]);
  await write(chain, admin, bond, 'AgentBond', 'proposeSlasher', [escrow]);
  chain.advance(unbonding);
  return { usdc, registry, bond, escrow, admin, arbiter, treasury };
}

export async function write(chain, from, address, name, functionName, args = []) {
  const hash = await from.client.writeContract({ address, abi: abi(name), functionName, args, gas: 30_000_000n, gasPrice: 0n });
  return chain.publicClient.waitForTransactionReceipt({ hash });
}

export function read(chain, address, name, functionName, args = []) {
  return chain.publicClient.readContract({ address, abi: abi(name), functionName, args });
}
