import { commons, config, hd, helpers, Indexer, RPC, utils, type Cell, type CellDep, type Script } from '@ckb-lumos/lumos';
import { blockchain } from '@ckb-lumos/base';
import { bytes } from '@ckb-lumos/codec';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { fromMinorUnits } from '../lib/money.js';
import { parseCkbAddress } from './ckbChain.service.js';
import { deriveVaultForWallet, getVaultRuntimeConfig, minimalVaultCellCapacityShannons } from './vault.service.js';

export interface VaultPayoutInput {
  ownerWalletId: string;
  sessionId: string;
  recipientAddress: string;
  amountMinor: number;
  currency: string;
}

export interface VaultPayoutResult {
  provider: 'ckb-vault';
  network: string;
  proofId: string;
}

export interface VaultLiquidityBridgeInput {
  ownerWalletId: string;
  sessionId: string;
  nodeFundingAddress: string;
  amountMinor: number;
  currency: string;
}

export interface VaultPayoutReadiness {
  ready: boolean;
  code?: string;
  message?: string;
}

type RpcScript = { code_hash: string; hash_type: string; args: string };
type RpcOutput = { capacity: string; lock: RpcScript; type?: RpcScript | null };
type RpcCell = {
  out_point: { tx_hash: string; index: string };
  output: RpcOutput;
  output_data: string;
};

const VAULT_OPERATOR_PAYOUT_WITNESS = bytes.hexify(blockchain.WitnessArgs.pack({ lock: '0x01' }));
const DEFAULT_OPERATOR_FEE_SHANNONS = 300000n;
const MAX_PAYOUT_INPUT_CELLS = 40;
const MAX_OPERATOR_FEE_CELLS = 40;
const SECP_SIGNATURE_PLACEHOLDER = '0x' + '00'.repeat(65);

function networkConfig() {
  return env.FIBER_NETWORK.toLowerCase().includes('main') ? config.MAINNET : config.TESTNET;
}

function ckbRpcUrl(): string {
  return env.CKB_TESTNET_RPC_URL;
}

function ckbIndexerUrl(): string {
  return env.CKB_TESTNET_INDEXER_URL;
}

function toHex(value: bigint | number): string {
  return '0x' + BigInt(value).toString(16);
}

function normalizeScript(script: RpcScript): Script {
  return {
    codeHash: script.code_hash,
    hashType: script.hash_type as Script['hashType'],
    args: script.args
  };
}

function scriptToRpc(script: Script): RpcScript {
  return {
    code_hash: script.codeHash,
    hash_type: script.hashType,
    args: script.args
  };
}

function parseCapacity(value: string): bigint {
  return BigInt(value);
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

async function listVaultCells(lock: Script): Promise<Cell[]> {
  const searchKey = {
    script: scriptToRpc(lock),
    script_type: 'lock',
    script_search_mode: 'exact'
  };
  const result = await rpcRequest<{ objects: RpcCell[] }>(ckbIndexerUrl(), 'get_cells', [searchKey, 'asc', toHex(MAX_PAYOUT_INPUT_CELLS)]);
  return result.objects.map((cell) => ({
    cellOutput: {
      capacity: cell.output.capacity,
      lock: normalizeScript(cell.output.lock),
      type: cell.output.type ? normalizeScript(cell.output.type) : undefined
    },
    data: cell.output_data || '0x',
    outPoint: {
      txHash: cell.out_point.tx_hash,
      index: cell.out_point.index
    }
  }));
}

function minimalRecipientCapacityMinor(recipientAddress: string): number {
  const lock = parseCkbAddress(recipientAddress);
  const cell = {
    cellOutput: {
      capacity: '0x0',
      lock,
      type: undefined
    },
    data: '0x'
  } as Parameters<typeof helpers.minimalCellCapacity>[0];
  const capacity = Number(helpers.minimalCellCapacity(cell));
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new ApiError(500, 'CKB_MIN_CAPACITY_UNSAFE', 'Unable to calculate recipient CKB cell minimum capacity.');
  }
  return capacity;
}

function vaultCellDep(): CellDep {
  if (!env.FIBERPASS_VAULT_CELL_DEP_TX_HASH || !env.FIBERPASS_VAULT_CELL_DEP_INDEX) {
    throw new ApiError(503, 'VAULT_CELL_DEP_NOT_CONFIGURED', 'Direct vault payouts require the deployed vault lock cell dep tx hash and index.');
  }
  const depType = env.FIBERPASS_VAULT_CELL_DEP_TYPE === 'dep_group' ? 'depGroup' : env.FIBERPASS_VAULT_CELL_DEP_TYPE;
  return {
    outPoint: {
      txHash: env.FIBERPASS_VAULT_CELL_DEP_TX_HASH,
      index: env.FIBERPASS_VAULT_CELL_DEP_INDEX
    },
    depType
  };
}

function operatorSigner(): { privateKey: string; address: string; lockHash: string; lock: Script } {
  const privateKey = env.FIBERPASS_OPERATOR_PRIVATE_KEY.trim();
  if (!privateKey) {
    throw new ApiError(
      503,
      'VAULT_PAYOUT_SIGNER_NOT_CONFIGURED',
      'Direct vault payouts are enabled in the product flow, but the backend operator signer is not configured yet.'
    );
  }

  const secp = networkConfig().SCRIPTS.SECP256K1_BLAKE160;
  if (!secp) {
    throw new ApiError(500, 'SECP_SCRIPT_NOT_CONFIGURED', 'CKB secp256k1 script config is unavailable.');
  }

  const operatorLock: Script = {
    codeHash: secp.CODE_HASH,
    hashType: secp.HASH_TYPE as Script['hashType'],
    args: hd.key.privateKeyToBlake160(privateKey)
  };
  const lockHash = utils.computeScriptHash(operatorLock);
  if (env.FIBERPASS_OPERATOR_LOCK_HASH && lockHash.toLowerCase() !== env.FIBERPASS_OPERATOR_LOCK_HASH.toLowerCase()) {
    throw new ApiError(503, 'VAULT_OPERATOR_SIGNER_MISMATCH', 'Configured operator private key does not match FIBERPASS_OPERATOR_LOCK_HASH.');
  }

  return {
    privateKey,
    address: helpers.encodeToAddress(operatorLock, { config: networkConfig() }),
    lockHash,
    lock: operatorLock
  };
}

export function getVaultPayoutReadiness(): VaultPayoutReadiness {
  const runtime = getVaultRuntimeConfig();
  if (!runtime.configured) {
    return { ready: false, code: 'VAULT_PAYOUT_NOT_CONFIGURED', message: 'Direct vault payouts require the deployed FiberPass vault configuration.' };
  }

  try {
    operatorSigner();
    vaultCellDep();
    return { ready: true };
  } catch (error) {
    if (error instanceof ApiError) {
      return { ready: false, code: error.code, message: error.message };
    }
    const message = error instanceof Error && error.message ? error.message : 'Direct vault payout configuration is not ready.';
    return { ready: false, code: 'VAULT_PAYOUT_NOT_READY', message };
  }
}

function outPointKey(outPoint?: { txHash: string; index: string }): string | undefined {
  return outPoint ? outPoint.txHash.toLowerCase() + ':' + outPoint.index.toLowerCase() : undefined;
}

function addCellDepOnce(txSkeleton: ReturnType<typeof helpers.TransactionSkeleton>, cellDep: CellDep): ReturnType<typeof helpers.TransactionSkeleton> {
  const key = outPointKey(cellDep.outPoint) + ':' + cellDep.depType;
  const exists = txSkeleton.get('cellDeps').some((existing) => outPointKey(existing.outPoint) + ':' + existing.depType === key);
  if (exists) return txSkeleton;
  return txSkeleton.update('cellDeps', (cellDeps) => cellDeps.push(cellDep));
}

function secpCellDep(): CellDep {
  const secp = networkConfig().SCRIPTS.SECP256K1_BLAKE160;
  if (!secp) {
    throw new ApiError(500, 'SECP_SCRIPT_NOT_CONFIGURED', 'CKB secp256k1 script config is unavailable.');
  }
  return {
    outPoint: {
      txHash: secp.TX_HASH,
      index: secp.INDEX
    },
    depType: secp.DEP_TYPE
  };
}

function minimalPlainCellCapacityMinor(lock: Script): bigint {
  const cell = {
    cellOutput: {
      capacity: '0x0',
      lock,
      type: undefined
    },
    data: '0x'
  } as Parameters<typeof helpers.minimalCellCapacity>[0];
  return BigInt(helpers.minimalCellCapacity(cell));
}

async function listOperatorFeeCells(lock: Script, excludedOutPoints: Set<string>): Promise<Cell[]> {
  const searchKey = {
    script: scriptToRpc(lock),
    script_type: 'lock',
    script_search_mode: 'exact'
  };
  const result = await rpcRequest<{ objects: RpcCell[] }>(ckbIndexerUrl(), 'get_cells', [searchKey, 'asc', toHex(MAX_OPERATOR_FEE_CELLS)]);
  return result.objects
    .filter((cell) => !cell.output.type && (cell.output_data || '0x') === '0x')
    .map((cell) => ({
      cellOutput: {
        capacity: cell.output.capacity,
        lock: normalizeScript(cell.output.lock),
        type: undefined
      },
      data: '0x',
      outPoint: {
        txHash: cell.out_point.tx_hash,
        index: cell.out_point.index
      }
    }))
    .filter((cell) => {
      const key = outPointKey(cell.outPoint);
      return key ? !excludedOutPoints.has(key) : true;
    });
}

function setSecpSigningWitness(txSkeleton: ReturnType<typeof helpers.TransactionSkeleton>, lockHash: string): ReturnType<typeof helpers.TransactionSkeleton> {
  const firstIndex = txSkeleton.get('inputs').findIndex((input) => utils.computeScriptHash(input.cellOutput.lock).toLowerCase() === lockHash.toLowerCase());
  if (firstIndex < 0) return txSkeleton;
  while (firstIndex >= txSkeleton.get('witnesses').size) {
    txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.push('0x'));
  }
  const witness = bytes.hexify(blockchain.WitnessArgs.pack({ lock: SECP_SIGNATURE_PLACEHOLDER }));
  return txSkeleton.update('witnesses', (witnesses) => witnesses.set(firstIndex, witness));
}

async function payOperatorFee(input: {
  txSkeleton: ReturnType<typeof helpers.TransactionSkeleton>;
  operator: ReturnType<typeof operatorSigner>;
  feeMinor: bigint;
  excludedOutPoints: Set<string>;
}): Promise<ReturnType<typeof helpers.TransactionSkeleton>> {
  const feeCells = await listOperatorFeeCells(input.operator.lock, input.excludedOutPoints);
  const minChangeMinor = minimalPlainCellCapacityMinor(input.operator.lock);
  let total = 0n;
  const selected: Cell[] = [];

  for (const cell of feeCells) {
    selected.push(cell);
    total += parseCapacity(cell.cellOutput.capacity);
    const change = total - input.feeMinor;
    if (change === 0n || change >= minChangeMinor) break;
  }

  const change = total - input.feeMinor;
  if (selected.length === 0 || change < 0n || (change > 0n && change < minChangeMinor)) {
    throw new ApiError(402, 'OPERATOR_FEE_CAPACITY_INSUFFICIENT', 'Operator fee wallet does not have enough plain CKB cells for the vault payout fee.');
  }

  let txSkeleton = addCellDepOnce(input.txSkeleton, secpCellDep());
  for (const cell of selected) {
    txSkeleton = txSkeleton.update('inputs', (inputs) => inputs.push(cell));
    txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.push('0x'));
  }

  if (change > 0n) {
    txSkeleton = txSkeleton.update('outputs', (outputs) => outputs.push({
      cellOutput: {
        capacity: toHex(change),
        lock: input.operator.lock,
        type: undefined
      },
      data: '0x'
    }));
  }

  return setSecpSigningWitness(txSkeleton, input.operator.lockHash);
}

function selectVaultCells(input: { cells: Cell[]; amountMinor: bigint; minChangeMinor: bigint }): { selected: Cell[]; total: bigint; change: bigint } {
  let total = 0n;
  const selected: Cell[] = [];
  for (const cell of input.cells) {
    selected.push(cell);
    total += parseCapacity(cell.cellOutput.capacity);
    const change = total - input.amountMinor;
    if (change === 0n || change >= input.minChangeMinor) {
      return { selected, total, change };
    }
  }

  throw new ApiError(402, 'VAULT_LIVE_CAPACITY_INSUFFICIENT', 'Vault live cells do not have enough spendable CKB for this payout plus change capacity.');
}

async function executeVaultPlainTransfer(input: {
  ownerWalletId: string;
  recipientAddress: string;
  amountMinor: number;
  currency: string;
  minimumErrorCode: string;
  minimumErrorLabel: string;
  failureCode: string;
  failureLabel: string;
}): Promise<VaultPayoutResult> {
  const runtime = getVaultRuntimeConfig();
  if (!runtime.configured) {
    throw new ApiError(503, 'VAULT_PAYOUT_NOT_CONFIGURED', 'Direct vault payouts require the deployed FiberPass vault configuration.');
  }

  const operator = operatorSigner();
  const vaultDep = vaultCellDep();
  const vault = deriveVaultForWallet({ walletId: input.ownerWalletId });
  if (!vault) {
    throw new ApiError(503, 'USER_VAULT_NOT_CONFIGURED', 'This wallet does not have a configured FiberPass vault.');
  }

  const minRecipientMinor = minimalRecipientCapacityMinor(input.recipientAddress);
  if (input.amountMinor < minRecipientMinor) {
    throw new ApiError(
      400,
      input.minimumErrorCode,
      input.minimumErrorLabel + ' must be at least ' + fromMinorUnits(minRecipientMinor, input.currency).toLocaleString('en-US') + ' ' + input.currency + '.'
    );
  }

  const amountMinor = BigInt(input.amountMinor);
  const recipientLock = parseCkbAddress(input.recipientAddress);
  const minVaultChangeMinor = BigInt(minimalVaultCellCapacityShannons(vault.script));
  const cells = await listVaultCells(vault.script);
  if (cells.length === 0) {
    throw new ApiError(402, 'VAULT_LIVE_CELLS_NOT_FOUND', 'No live CKB vault cells were found for this wallet.');
  }

  const { selected, change } = selectVaultCells({ cells, amountMinor, minChangeMinor: minVaultChangeMinor });
  const indexer = new Indexer(ckbIndexerUrl(), ckbRpcUrl());
  const rpc = new RPC(ckbRpcUrl());
  let txSkeleton = helpers.TransactionSkeleton({ cellProvider: indexer });
  txSkeleton = addCellDepOnce(txSkeleton, vaultDep);

  for (const cell of selected) {
    txSkeleton = txSkeleton.update('inputs', (inputs) => inputs.push(cell));
    txSkeleton = txSkeleton.update('witnesses', (witnesses) => witnesses.push(VAULT_OPERATOR_PAYOUT_WITNESS));
  }

  txSkeleton = txSkeleton.update('outputs', (outputs) => outputs.push({
    cellOutput: {
      capacity: toHex(amountMinor),
      lock: recipientLock,
      type: undefined
    },
    data: '0x'
  }));

  if (change > 0n) {
    txSkeleton = txSkeleton.update('outputs', (outputs) => outputs.push({
      cellOutput: {
        capacity: toHex(change),
        lock: vault.script,
        type: undefined
      },
      data: '0x'
    }));
  }

  try {
    const excludedOutPoints = new Set<string>();
    for (const cell of selected) {
      const key = outPointKey(cell.outPoint);
      if (key) excludedOutPoints.add(key);
    }
    excludedOutPoints.add(outPointKey(vaultDep.outPoint) ?? '');
    txSkeleton = await payOperatorFee({ txSkeleton, operator, feeMinor: DEFAULT_OPERATOR_FEE_SHANNONS, excludedOutPoints });
    txSkeleton = commons.secp256k1Blake160.prepareSigningEntries(txSkeleton, { config: networkConfig() });
    const signingEntries = txSkeleton.get('signingEntries').toArray() as Array<{ message: string }>;
    const signatures = signingEntries.map((entry) => hd.key.signRecoverable(entry.message, operator.privateKey));
    const tx = helpers.sealTransaction(txSkeleton, signatures);
    const txHash = await rpc.sendTransaction(tx, 'passthrough');
    return { provider: 'ckb-vault', network: env.FIBER_NETWORK, proofId: txHash };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error && error.message ? error.message : input.failureLabel + ' transaction failed.';
    throw new ApiError(502, input.failureCode, message);
  }
}

export async function executeVaultPayout(input: VaultPayoutInput): Promise<VaultPayoutResult> {
  return executeVaultPlainTransfer({
    ownerWalletId: input.ownerWalletId,
    recipientAddress: input.recipientAddress,
    amountMinor: input.amountMinor,
    currency: input.currency,
    minimumErrorCode: 'CKB_PAYOUT_BELOW_CELL_MINIMUM',
    minimumErrorLabel: 'Direct CKB payouts to a wallet',
    failureCode: 'VAULT_PAYOUT_TX_FAILED',
    failureLabel: 'CKB vault payout'
  });
}

export async function executeVaultLiquidityBridge(input: VaultLiquidityBridgeInput): Promise<VaultPayoutResult> {
  return executeVaultPlainTransfer({
    ownerWalletId: input.ownerWalletId,
    recipientAddress: input.nodeFundingAddress,
    amountMinor: input.amountMinor,
    currency: input.currency,
    minimumErrorCode: 'FIBER_LIQUIDITY_BELOW_CELL_MINIMUM',
    minimumErrorLabel: 'Fiber liquidity bridge transfers',
    failureCode: 'FIBER_LIQUIDITY_BRIDGE_TX_FAILED',
    failureLabel: 'Fiber liquidity bridge'
  });
}
