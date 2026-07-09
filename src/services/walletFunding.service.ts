import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { liveEvents } from '../lib/liveEvents.js';
import { fromMinorUnits, toMinorUnits } from '../lib/money.js';
import { WalletFundingModel, type WalletFundingRecord } from '../models/walletFunding.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { getSessionsOverview, type SessionsOverviewDto } from './session.service.js';
import { writeAuditLog } from './audit.service.js';
import {
  findVaultDepositInTransaction,
  listLiveVaultCells,
  normalizeCkbTxHash,
  type CkbDepositOutput
} from './ckbChain.service.js';
import { deriveVaultForWallet, getVaultRuntimeConfig, minimalVaultCellCapacityShannons, type DerivedVaultDto } from './vault.service.js';

const FUNDING_CURRENCY = 'CKB';
const MIN_FUNDING_MINOR = toMinorUnits('138', FUNDING_CURRENCY);
const MAX_FUNDING_MINOR = toMinorUnits('100000', FUNDING_CURRENCY);
type WalletFundingDocument = WalletFundingRecord & { save: () => Promise<unknown> };

export interface WalletFundingConfigDto {
  currency: string;
  network: string;
  depositMode: 'vault' | 'treasury';
  depositAddress: string;
  configured: boolean;
  minAmount: number;
  minAmountMinor: number;
  maxAmount: number;
  maxAmountMinor: number;
  chain: {
    rpcConfigured: boolean;
    indexerConfigured: boolean;
  };
  vault?: {
    configured: boolean;
    address?: string;
    scriptHash?: string;
    ownerLockHashSource?: string;
  };
}

export interface WalletFundingRequestDto {
  id: string;
  walletAddress: string;
  amount: number;
  amountMinor: number;
  currency: string;
  network: string;
  depositMode?: string;
  depositAddress: string;
  vaultScriptHash?: string;
  vaultScriptArgs?: string;
  vaultOwnerLockHash?: string;
  vaultOwnerLockHashSource?: string;
  vaultAccountIdHash?: string;
  memo: string;
  proofId?: string;
  chainTxHash?: string;
  chainOutputIndex?: string;
  chainOutPoint?: string;
  chainBlockHash?: string;
  chainBlockNumber?: string;
  chainCapacityShannons?: number;
  chainConfirmedAt?: string;
  status: WalletFundingRecord['status'];
  createdAt: string;
  confirmedAt?: string;
}

export interface WalletFundingOverviewDto {
  config: WalletFundingConfigDto;
  requests: WalletFundingRequestDto[];
}

function newFundingId(): string {
  return 'fp_fund_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function fundingMemo(walletId: string, fundingId: string): string {
  return ['fiberpass', fundingId, walletId.slice(0, 12)].join(':');
}

function minimumFundingMinor(vault?: DerivedVaultDto | null): number {
  return Math.max(MIN_FUNDING_MINOR, vault ? minimalVaultCellCapacityShannons(vault.script) : MIN_FUNDING_MINOR);
}

function getFundingConfig(walletId?: string): WalletFundingConfigDto {
  const vault = walletId ? deriveVaultForWallet({ walletId }) : null;
  const vaultRuntime = getVaultRuntimeConfig();
  const depositAddress = vault?.address ?? env.FIBERPASS_TREASURY_ADDRESS;
  const depositMode = vault ? 'vault' : 'treasury';
  const minAmountMinor = minimumFundingMinor(vault);

  return {
    currency: FUNDING_CURRENCY,
    network: env.FIBER_NETWORK,
    depositMode,
    depositAddress,
    configured: Boolean(depositAddress),
    minAmount: fromMinorUnits(minAmountMinor, FUNDING_CURRENCY),
    minAmountMinor,
    maxAmount: fromMinorUnits(MAX_FUNDING_MINOR, FUNDING_CURRENCY),
    maxAmountMinor: MAX_FUNDING_MINOR,
    chain: {
      rpcConfigured: Boolean(env.CKB_TESTNET_RPC_URL),
      indexerConfigured: Boolean(env.CKB_TESTNET_INDEXER_URL)
    },
    vault: {
      configured: vaultRuntime.configured,
      address: vault?.address,
      scriptHash: vault?.scriptHash,
      ownerLockHashSource: vault?.ownerLockHashSource
    }
  };
}

function requireFundingConfig(walletId: string): WalletFundingConfigDto & { vaultDetails?: DerivedVaultDto } {
  const vaultDetails = deriveVaultForWallet({ walletId }) ?? undefined;
  const config = getFundingConfig(walletId);
  if (!config.configured) {
    throw new ApiError(503, 'FUNDING_ADDRESS_NOT_CONFIGURED', 'Wallet funding is unavailable until FiberPass vault deployment env is configured on the backend.');
  }
  if (config.depositMode !== 'vault' || !vaultDetails) {
    throw new ApiError(503, 'VAULT_FUNDING_NOT_CONFIGURED', 'Beta funding requires the deployed CKB vault configuration. Treasury/manual funding is disabled.');
  }
  return { ...config, vaultDetails };
}

function toFundingDto(record: WalletFundingRecord & { createdAt?: Date; confirmedAt?: Date | null; chainConfirmedAt?: Date | null }): WalletFundingRequestDto {
  return {
    id: record.fundingId,
    walletAddress: record.walletAddress,
    amount: fromMinorUnits(record.amountMinor, record.currency),
    amountMinor: record.amountMinor,
    currency: record.currency,
    network: record.network,
    depositMode: record.depositMode ?? 'treasury',
    depositAddress: record.depositAddress,
    vaultScriptHash: record.vaultScriptHash ?? undefined,
    vaultScriptArgs: record.vaultScriptArgs ?? undefined,
    vaultOwnerLockHash: record.vaultOwnerLockHash ?? undefined,
    vaultOwnerLockHashSource: record.vaultOwnerLockHashSource ?? undefined,
    vaultAccountIdHash: record.vaultAccountIdHash ?? undefined,
    memo: record.memo,
    proofId: record.proofId ?? undefined,
    chainTxHash: record.chainTxHash ?? undefined,
    chainOutputIndex: record.chainOutputIndex ?? undefined,
    chainOutPoint: record.chainOutPoint ?? undefined,
    chainBlockHash: record.chainBlockHash ?? undefined,
    chainBlockNumber: record.chainBlockNumber ?? undefined,
    chainCapacityShannons: record.chainCapacityShannons ?? undefined,
    chainConfirmedAt: record.chainConfirmedAt?.toISOString(),
    status: record.status,
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    confirmedAt: record.confirmedAt?.toISOString()
  };
}

function validateFundingAmount(amount: number, minFundingMinor: number): number {
  const amountMinor = toMinorUnits(String(amount), FUNDING_CURRENCY);
  if (amountMinor < minFundingMinor || amountMinor > MAX_FUNDING_MINOR) {
    throw new ApiError(400, 'FUNDING_AMOUNT_OUT_OF_RANGE', 'Funding amount must be between ' + fromMinorUnits(minFundingMinor, FUNDING_CURRENCY).toLocaleString('en-US') + ' and 100,000 CKB.');
  }
  return amountMinor;
}

async function getWalletOrThrow(walletId: string) {
  const wallet = await WalletModel.findOne({ walletId });
  if (!wallet) {
    throw new ApiError(404, 'WALLET_NOT_FOUND', 'Connect with JoyID before loading wallet funds.');
  }
  return wallet;
}

async function usedVaultOutPoints(): Promise<Set<string>> {
  const records = await WalletFundingModel.find({
    status: 'confirmed',
    chainOutPoint: { $exists: true, $ne: '' }
  }).select('chainOutPoint').lean<Array<{ chainOutPoint?: string }>>();
  return new Set(records.map((record) => record.chainOutPoint).filter((value): value is string => Boolean(value)));
}

async function applyConfirmedFunding(input: {
  walletId: string;
  funding: WalletFundingDocument | null;
  deposit: CkbDepositOutput;
  proofId: string;
}): Promise<void> {
  const { walletId, funding, deposit, proofId } = input;
  if (!funding) throw new ApiError(404, 'FUNDING_REQUEST_NOT_FOUND', 'Wallet funding request was not found.');

  const outPointExists = await WalletFundingModel.exists({
    fundingId: { $ne: funding.fundingId },
    chainOutPoint: deposit.outPoint,
    status: 'confirmed'
  });
  if (outPointExists) {
    throw new ApiError(409, 'FUNDING_OUTPOINT_ALREADY_USED', 'This vault deposit output has already been credited.');
  }

  const now = new Date();
  const requestedAmountMinor = funding.amountMinor;
  const creditedMinor = deposit.capacityShannons;
  funding.status = 'confirmed';
  funding.proofId = proofId;
  funding.chainTxHash = deposit.txHash;
  funding.chainOutputIndex = deposit.outputIndex;
  funding.chainOutPoint = deposit.outPoint;
  funding.chainBlockHash = deposit.blockHash;
  funding.chainBlockNumber = deposit.blockNumber;
  funding.chainCapacityShannons = deposit.capacityShannons;
  funding.chainConfirmedAt = now;
  funding.confirmedAt = now;
  funding.amountMinor = creditedMinor;
  funding.amount = fromMinorUnits(creditedMinor, funding.currency);
  await funding.save();

  const amount = fromMinorUnits(creditedMinor, funding.currency);
  await WalletModel.updateOne(
    { walletId },
    {
      $set: { currency: FUNDING_CURRENCY },
      $inc: {
        balanceMinor: creditedMinor,
        balance: amount
      }
    }
  );

  await writeAuditLog({
    actorWalletId: walletId,
    actorAddress: funding.walletAddress,
    action: 'wallet_funding.confirmed',
    targetType: 'wallet_funding',
    targetId: funding.fundingId,
    metadata: {
      amountMinor: creditedMinor,
      requestedAmountMinor,
      currency: funding.currency,
      txHash: deposit.txHash,
      outPoint: deposit.outPoint,
      capacityShannons: deposit.capacityShannons
    }
  });
}

export async function listWalletFunding(walletId: string): Promise<WalletFundingOverviewDto> {
  const requests = await WalletFundingModel.find({ walletId }).sort({ createdAt: -1 }).limit(20).lean<(WalletFundingRecord & { createdAt?: Date; confirmedAt?: Date; chainConfirmedAt?: Date })[]>();
  return {
    config: getFundingConfig(walletId),
    requests: requests.map(toFundingDto)
  };
}

export async function createWalletFundingRequest(walletId: string, amount: number): Promise<WalletFundingRequestDto> {
  const wallet = await getWalletOrThrow(walletId);
  const config = requireFundingConfig(walletId);
  const vaultDetails = config.vaultDetails;
  const amountMinor = validateFundingAmount(amount, config.minAmountMinor);
  const fundingId = newFundingId();
  const record = await WalletFundingModel.create({
    fundingId,
    walletId,
    walletAddress: wallet.address,
    amount: fromMinorUnits(amountMinor, FUNDING_CURRENCY),
    amountMinor,
    currency: FUNDING_CURRENCY,
    network: config.network,
    depositMode: config.depositMode,
    depositAddress: config.depositAddress,
    vaultScriptHash: vaultDetails?.scriptHash,
    vaultScriptArgs: vaultDetails?.script.args,
    vaultOwnerLockHash: vaultDetails?.ownerLockHash,
    vaultOwnerLockHashSource: vaultDetails?.ownerLockHashSource,
    vaultAccountIdHash: vaultDetails?.accountIdHash,
    memo: fundingMemo(walletId, fundingId),
    status: 'pending'
  });

  await WalletModel.updateOne({ walletId }, { $set: { currency: FUNDING_CURRENCY } });

  await writeAuditLog({
    actorWalletId: walletId,
    actorAddress: wallet.address,
    action: 'wallet_funding.requested',
    targetType: 'wallet_funding',
    targetId: fundingId,
    metadata: { amountMinor, currency: FUNDING_CURRENCY, network: config.network, depositMode: config.depositMode, vaultScriptHash: vaultDetails?.scriptHash }
  });

  return toFundingDto(record.toObject());
}

export async function syncWalletFunding(walletId: string): Promise<WalletFundingOverviewDto> {
  const pendingRequests = await WalletFundingModel.find({ walletId, status: 'pending', depositMode: 'vault' }).sort({ createdAt: 1 });
  if (pendingRequests.length === 0) {
    return listWalletFunding(walletId);
  }

  const used = await usedVaultOutPoints();
  const vaultByScriptHash = new Map<string, Awaited<ReturnType<typeof listLiveVaultCells>>>();

  for (const funding of pendingRequests) {
    const vault = deriveVaultForWallet({ walletId });
    if (!vault || funding.vaultScriptHash !== vault.scriptHash) continue;

    let liveCells = vaultByScriptHash.get(vault.scriptHash);
    if (!liveCells) {
      liveCells = await listLiveVaultCells({ lock: vault.script });
      vaultByScriptHash.set(vault.scriptHash, liveCells);
    }

    const cell = liveCells.find((candidate) => !used.has(candidate.outPoint) && candidate.capacityShannons >= funding.amountMinor);
    if (!cell) continue;

    await applyConfirmedFunding({
      walletId,
      funding,
      proofId: cell.txHash,
      deposit: {
        txHash: cell.txHash,
        outputIndex: cell.outputIndex,
        outPoint: cell.outPoint,
        capacityShannons: cell.capacityShannons,
        blockNumber: cell.blockNumber
      }
    });
    used.add(cell.outPoint);
  }

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return listWalletFunding(walletId);
}

export async function confirmWalletFundingRequest(walletId: string, fundingId: string, proofId: string): Promise<SessionsOverviewDto> {
  const txHash = normalizeCkbTxHash(proofId);
  const funding = await WalletFundingModel.findOne({ walletId, fundingId });
  if (!funding) {
    throw new ApiError(404, 'FUNDING_REQUEST_NOT_FOUND', 'Wallet funding request was not found.');
  }

  if (funding.status === 'confirmed') {
    throw new ApiError(409, 'FUNDING_ALREADY_CONFIRMED', 'This wallet funding request is already confirmed.');
  }

  if (funding.depositMode !== 'vault') {
    throw new ApiError(409, 'MANUAL_FUNDING_DISABLED', 'Only CKB vault deposits can be confirmed in beta.');
  }

  const vault = deriveVaultForWallet({ walletId });
  if (!vault || vault.scriptHash !== funding.vaultScriptHash) {
    throw new ApiError(409, 'VAULT_ADDRESS_MISMATCH', 'Funding request vault does not match the connected wallet vault.');
  }

  const proofExists = await WalletFundingModel.exists({ proofId: txHash, status: 'confirmed' });
  if (proofExists) {
    throw new ApiError(409, 'FUNDING_PROOF_ALREADY_USED', 'This CKB transaction hash has already been recorded.');
  }

  const deposit = await findVaultDepositInTransaction({
    txHash,
    expectedLock: vault.script,
    minimumCapacityShannons: funding.amountMinor,
    usedOutPoints: await usedVaultOutPoints()
  });

  await applyConfirmedFunding({ walletId, funding, deposit, proofId: txHash });

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}
