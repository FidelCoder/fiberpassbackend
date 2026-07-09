import { helpers, config, type Script } from '@ckb-lumos/lumos';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

type RpcScript = { code_hash: string; hash_type: string; args: string };
type RpcOutput = { capacity: string; lock: RpcScript; type?: RpcScript | null };
type RpcTransaction = { hash: string; outputs: RpcOutput[]; outputs_data?: string[] };
type RpcTxStatus = { status: string; block_hash?: string | null; block_number?: string | null };
type RpcTransactionResult = { transaction: RpcTransaction; tx_status: RpcTxStatus; cycles?: string };
type RpcCell = {
  block_number: string;
  out_point: { tx_hash: string; index: string };
  output: RpcOutput;
  output_data: string;
  tx_index: string;
};

export interface CkbDepositOutput {
  txHash: string;
  outputIndex: string;
  outPoint: string;
  capacityShannons: number;
  blockHash?: string;
  blockNumber?: string;
}

export interface CkbLiveCell {
  txHash: string;
  outputIndex: string;
  outPoint: string;
  capacityShannons: number;
  blockNumber: string;
  txIndex: string;
}

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DEFAULT_MAX_LIVE_CELLS = 100;

function networkConfig() {
  return env.FIBER_NETWORK.toLowerCase().includes('main') ? config.MAINNET : config.TESTNET;
}

function ckbRpcUrl(): string {
  return env.FIBER_NETWORK.toLowerCase().includes('main') ? env.CKB_TESTNET_RPC_URL : env.CKB_TESTNET_RPC_URL;
}

function ckbIndexerUrl(): string {
  return env.FIBER_NETWORK.toLowerCase().includes('main') ? env.CKB_TESTNET_INDEXER_URL : env.CKB_TESTNET_INDEXER_URL;
}

function normalizeScript(script: Script | RpcScript): Script {
  if ('code_hash' in script) {
    return {
      codeHash: script.code_hash,
      hashType: script.hash_type as Script['hashType'],
      args: script.args
    };
  }
  return script;
}

function scriptKey(script: Script | RpcScript): string {
  const normalized = normalizeScript(script);
  return [
    normalized.codeHash.toLowerCase(),
    String(normalized.hashType).toLowerCase(),
    normalized.args.toLowerCase()
  ].join(':');
}

function parseCapacityShannons(value: string): number {
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(502, 'CKB_CAPACITY_UNSAFE', 'CKB capacity exceeds safe integer range.');
  }
  return parsed;
}

async function rpcRequest<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: Date.now(), jsonrpc: '2.0', method, params })
  });

  if (!response.ok) {
    throw new ApiError(502, 'CKB_RPC_HTTP_ERROR', 'CKB RPC request failed with HTTP ' + response.status + '.');
  }

  const payload = await response.json() as { result?: T; error?: { code?: number; message?: string } };
  if (payload.error) {
    throw new ApiError(502, 'CKB_RPC_ERROR', payload.error.message || 'CKB RPC request failed.', payload.error);
  }

  return payload.result as T;
}

export function normalizeCkbTxHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!TX_HASH_PATTERN.test(normalized)) {
    throw new ApiError(400, 'INVALID_CKB_TX_HASH', 'Enter a valid CKB testnet transaction hash.');
  }
  return normalized;
}

export function parseCkbAddress(address: string): Script {
  try {
    return helpers.parseAddress(address, { config: networkConfig() });
  } catch {
    throw new ApiError(400, 'INVALID_CKB_ADDRESS', 'Funding address is not a valid CKB address for this network.');
  }
}

export async function getCkbTransaction(txHash: string): Promise<RpcTransactionResult | null> {
  const normalizedTxHash = normalizeCkbTxHash(txHash);
  return rpcRequest<RpcTransactionResult | null>(ckbRpcUrl(), 'get_transaction', [normalizedTxHash]);
}

export async function findVaultDepositInTransaction(input: {
  txHash: string;
  expectedLock: Script;
  minimumCapacityShannons: number;
  usedOutPoints?: Set<string>;
}): Promise<CkbDepositOutput> {
  const txHash = normalizeCkbTxHash(input.txHash);
  const transaction = await getCkbTransaction(txHash);
  if (!transaction) {
    throw new ApiError(404, 'CKB_TX_NOT_FOUND', 'CKB transaction was not found on testnet.');
  }

  if (transaction.tx_status.status !== 'committed') {
    throw new ApiError(409, 'CKB_TX_NOT_COMMITTED', 'CKB transaction is not committed yet. Wait for confirmation, then sync again.');
  }

  const expectedKey = scriptKey(input.expectedLock);
  for (const [index, output] of transaction.transaction.outputs.entries()) {
    if (scriptKey(output.lock) !== expectedKey) continue;

    const outputIndex = '0x' + index.toString(16);
    const outPoint = txHash + ':' + outputIndex;
    if (input.usedOutPoints?.has(outPoint)) continue;

    const capacityShannons = parseCapacityShannons(output.capacity);
    if (capacityShannons < input.minimumCapacityShannons) continue;

    return {
      txHash,
      outputIndex,
      outPoint,
      capacityShannons,
      blockHash: transaction.tx_status.block_hash ?? undefined,
      blockNumber: transaction.tx_status.block_number ?? undefined
    };
  }

  throw new ApiError(422, 'CKB_DEPOSIT_OUTPUT_NOT_FOUND', 'Transaction does not contain an unused vault output with enough CKB for this funding request.');
}

export async function listLiveVaultCells(input: {
  lock: Script;
  minCapacityShannons?: number;
  limit?: number;
}): Promise<CkbLiveCell[]> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_MAX_LIVE_CELLS, 1), DEFAULT_MAX_LIVE_CELLS);
  const searchKey = {
    script: {
      code_hash: input.lock.codeHash,
      hash_type: input.lock.hashType,
      args: input.lock.args
    },
    script_type: 'lock',
    script_search_mode: 'exact'
  };
  const result = await rpcRequest<{ objects: RpcCell[] }>(ckbIndexerUrl(), 'get_cells', [searchKey, 'asc', '0x' + limit.toString(16)]);

  return result.objects
    .map((cell) => ({
      txHash: cell.out_point.tx_hash.toLowerCase(),
      outputIndex: cell.out_point.index,
      outPoint: cell.out_point.tx_hash.toLowerCase() + ':' + cell.out_point.index,
      capacityShannons: parseCapacityShannons(cell.output.capacity),
      blockNumber: cell.block_number,
      txIndex: cell.tx_index
    }))
    .filter((cell) => cell.capacityShannons >= (input.minCapacityShannons ?? 0));
}
