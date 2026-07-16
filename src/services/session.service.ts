import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { ckbTransactionExplorerUrl } from '../lib/ckbExplorer.js';
import { listLiveVaultCells } from './ckbChain.service.js';
import { ApiError } from '../lib/errors.js';
import { FIBER_CKB_ADDRESS_ERROR, isFiberCkbAddress } from '../lib/fiberAddress.js';
import { liveEvents } from '../lib/liveEvents.js';
import { clampMinorUnits, fallbackMinorUnits, fromMinorUnits, roundMoney, toMinorUnits } from '../lib/money.js';
import { AppModel, type AppRecord } from '../models/app.model.js';
import { ChargeAttemptModel, type ChargeAttemptRecord } from '../models/chargeAttempt.model.js';
import { ICON_TYPES, PAYMENT_PURPOSES, RELEASE_CADENCES, SESSION_APP_PERMISSIONS, SessionModel, type IconType, type PaymentPurpose, type ReleaseCadence, type SessionAppPermission, type SessionRecord, type SessionStatus } from '../models/session.model.js';
import { WalletFundingModel } from '../models/walletFunding.model.js';
import { WalletModel, type WalletRecord } from '../models/wallet.model.js';
import { writeAuditLog } from './audit.service.js';
import {
  ChargeReservationError,
  claimChargeExecution,
  finalizeChargeReservation,
  markChargeOutcomeUncertain,
  markChargeProviderSubmitted,
  markChargeProviderSucceeded,
  releaseChargeReservation,
  reserveChargeAttempt,
  setChargeProviderCorrelation,
  type ProviderChargeResult
} from './chargeReservation.service.js';
import { requireEmailConfigured } from './email.service.js';
import { fiberAdapter, hashFiberPaymentRequest } from './fiberAdapter.js';
import { createFiberExitInvoice, executeFiberExitCkbSettlement } from './fiberExitGateway.service.js';
import { ensureVaultFundedFiberLiquidity, getCurrentFiberPayoutLiquiditySnapshot } from './fiberLiquidityBridge.service.js';
import { fiberProvider } from './fiberProvider.js';
import { sendRecipientInviteEmail, sendRecipientPayoutReceiptEmail } from './recipientEmail.service.js';
import { deriveVaultForWallet } from './vault.service.js';
import { executeVaultPayout } from './vaultPayout.service.js';

const LEGACY_PLACEHOLDER_BALANCE_MINOR = toMinorUnits('1240.50', 'USDC');
const HISTORY_STATUSES: SessionStatus[] = ['settled', 'revoked', 'expired'];
const OPEN_STATUSES: SessionStatus[] = ['active', 'paused'];
const MIN_FIBER_PAYMENT_REQUEST_LENGTH = 16;
const PAYOUT_PROCESSING_STALE_MS = 60000;
const PAYOUT_RETRY_BACKOFF_MS = 60000;
const RETRYABLE_VAULT_TX_FAILURE_PATTERN = 'InvalidInstruction|TransactionFailedToVerify|TransactionFailedToResolve|Resolve failed Unknown|PoolRejectedRBF';
const RETRYABLE_VAULT_CONFIG_FAILURE_CODES = [
  'VAULT_PAYOUT_SIGNER_NOT_CONFIGURED',
  'VAULT_CELL_DEP_NOT_CONFIGURED',
  'VAULT_PAYOUT_NOT_CONFIGURED',
  'VAULT_OPERATOR_SIGNER_MISMATCH',
  'VAULT_PAYOUT_NOT_READY',
  'VAULT_LIVE_CELLS_NOT_FOUND',
  'VAULT_LIVE_CAPACITY_INSUFFICIENT',
  'OPERATOR_FEE_CAPACITY_INSUFFICIENT'
] as const;
const RETRYABLE_FIBER_FAILURE_CODES = [
  'FIBER_PAYMENT_FAILED',
  'CHARGE_OUTCOME_UNCERTAIN',
  'CHARGE_FINALIZATION_PENDING',
  'FIBER_LIQUIDITY_BRIDGE_PENDING',
  'FIBER_LIQUIDITY_BRIDGE_TX_FAILED',
  'FIBER_CHANNEL_OPEN_PENDING',
  'FIBER_CHANNEL_OPEN_FAILED',
  'FIBER_NODE_UNREACHABLE',
  'FIBER_NODE_FUNDING_ADDRESS_MISSING',
  'FIBER_EXIT_RPC_FAILED',
  'FIBER_EXIT_INVOICE_CREATE_FAILED',
  'FIBER_EXIT_SETTLEMENT_NOT_READY',
  'FIBER_EXIT_SETTLEMENT_SIGNER_NOT_CONFIGURED',
  'FIBER_EXIT_SETTLEMENT_SIGNER_MISMATCH',
  'FIBER_EXIT_SETTLEMENT_CAPACITY_INSUFFICIENT',
  'FIBER_EXIT_SETTLEMENT_TX_FAILED'
] as const;
const PENDING_PAYOUT_FAILURE_CODES = [
  'FIBER_LIQUIDITY_BRIDGE_PENDING',
  'FIBER_CHANNEL_OPEN_PENDING',
  'CHARGE_ATTEMPT_PENDING'
] as const;

export const CREATE_SESSION_POLICY = {
  minLimit: 0.01,
  maxLimit: 100000,
  currency: 'CKB',
  minExpiryMinutes: 1,
  maxExpiryDays: 30,
  platformFeeBps: 50,
  minPlatformFee: 0.01,
  estimatedNetworkFee: 0.001
} as const;

export interface VerifiedAppDto {
  id: string;
  name: string;
  serviceAddress: string;
  url: string;
  category: string;
  trustLevel: 'verified' | 'reviewed' | 'manual';
  description: string;
  defaultCharge: number;
  defaultChargeMinor: number;
  chargePolicy: string;
  iconType: IconType;
  permissions: string[];
}

const VERIFIED_APP_CATALOG: VerifiedAppDto[] = [];

interface TransactionLogDto {
  id: string;
  type: string;
  timestamp: string;
  amount: number;
  amountMinor: number;
}

export interface RecipientWalletDto {
  name: string;
  address?: string;
  email?: string;
  recipientTimeZone?: string;
  amount?: number;
  amountMinor?: number;
  fiberInvoice?: string;
  status?: 'awaiting_details' | 'pending' | 'processing' | 'paid' | 'failed';
  chargeAttemptId?: string;
  paidAt?: string | Date;
  lastAttemptAt?: string | Date;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  inviteStatus?: 'not_required' | 'pending' | 'sent' | 'claimed' | 'expired' | 'send_failed';
  inviteTokenHash?: string;
  inviteTokenExpiresAt?: string | Date;
  inviteSentAt?: string | Date;
  inviteClaimedAt?: string | Date;
  inviteLastFailure?: string;
  payoutProofId?: string;
  payoutExplorerUrl?: string;
  payoutNotifiedAt?: string | Date;
  payoutNotificationStatus?: 'not_required' | 'pending' | 'sent' | 'failed';
  payoutNotificationFailure?: string;
  fiberLiquidityBridgeTxHash?: string;
  fiberLiquidityBridgeAmountMinor?: number;
  fiberLiquidityBridgeStatus?: string;
  fiberLiquidityBridgeCreatedAt?: string | Date;
  fiberLiquidityBridgeTopUpTxHash?: string;
  fiberLiquidityBridgeTopUpAmountMinor?: number;
  fiberLiquidityBridgeTopUpStatus?: string;
  fiberLiquidityBridgeTopUpCreatedAt?: string | Date;
  fiberChannelOpenProofId?: string;
  fiberChannelOpenAmountMinor?: number;
  fiberChannelOpenRequestedAt?: string | Date;
  fiberExitInvoice?: string;
  fiberExitInvoiceHash?: string;
  fiberExitPaymentProofId?: string;
  fiberExitPaymentAttemptId?: string;
  fiberExitSettlementTxHash?: string;
  fiberExitSettlementStatus?: string;
  fiberExitSettlementExplorerUrl?: string;
  fiberExitSettledAt?: string | Date;
}

export interface ChargeAttemptDto {
  id: string;
  sessionId: string;
  appId?: string;
  apiKeyId?: string;
  amount: number;
  amountMinor: number;
  currency: string;
  type: string;
  status: string;
  failureCode?: string;
  failureMessage?: string;
  resultingSpent?: number;
  resultingSpentMinor?: number;
  remainingBalance?: number;
  remainingBalanceMinor?: number;
  provider?: string;
  network?: string;
  providerStatus?: string;
  providerCorrelationId?: string;
  proofId?: string;
  proofType?: string;
  executionLayer?: string;
  reserveStatus?: string;
  idempotencyKey?: string;
  serviceReference?: string;
  paymentRequestHash?: string;
  explorerUrl?: string;
  createdAt: string;
}

type ChargeAttemptLike = Omit<ChargeAttemptRecord, 'createdAt'> & { createdAt?: Date };

interface SessionLike {
  ownerWalletId: string;
  publicId: string;
  name: string;
  serviceAddress: string;
  appId?: string;
  appUrl?: string;
  appTrustLevel?: string;
  appPermissions?: string[];
  appGrantOwnerWalletId?: string;
  appGrantCreatedAt?: Date;
  chargePolicy?: string;
  paymentPurpose?: PaymentPurpose;
  recipientName?: string;
  recipientAddress?: string;
  recipientWallets?: RecipientWalletDto[];
  paymentReference?: string;
  releaseCadence?: ReleaseCadence;
  nextReleaseAt?: Date;
  maxChargeAmount?: number;
  maxChargeAmountMinor?: number;
  conditionSummary?: string;
  expiryAt?: Date;
  platformFeeEstimate?: number;
  platformFeeEstimateMinor?: number;
  networkFeeEstimate?: number;
  networkFeeEstimateMinor?: number;
  spent: number;
  spentMinor?: number;
  reservedMinor?: number;
  limit: number;
  limitMinor?: number;
  currency: string;
  duration: string;
  status: SessionStatus;
  iconType: IconType;
  expiryTime: string;
  fiberProvider?: string;
  fiberNetwork?: string;
  fiberSessionId?: string;
  fiberStatus?: string;
  fiberProofId?: string;
  lastChargeProofId?: string;
  autoMicroCharges: boolean;
  singleUse: boolean;
  logs: TransactionLogDto[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SessionDto {
  id: string;
  name: string;
  serviceAddress: string;
  appId?: string;
  appUrl?: string;
  appTrustLevel?: string;
  appPermissions?: string[];
  appGrantOwnerWalletId?: string;
  appGrantCreatedAt?: string;
  chargePolicy?: string;
  paymentPurpose?: PaymentPurpose;
  recipientName?: string;
  recipientAddress?: string;
  recipientWallets?: RecipientWalletDto[];
  paymentReference?: string;
  releaseCadence?: ReleaseCadence;
  nextReleaseAt?: string;
  maxChargeAmount?: number;
  maxChargeAmountMinor?: number;
  conditionSummary?: string;
  expiryAt?: string;
  platformFeeEstimate?: number;
  platformFeeEstimateMinor?: number;
  networkFeeEstimate?: number;
  networkFeeEstimateMinor?: number;
  spent: number;
  spentMinor: number;
  reservedBalance: number;
  reservedBalanceMinor: number;
  limit: number;
  limitMinor: number;
  remainingBalance: number;
  remainingBalanceMinor: number;
  currency: string;
  duration: string;
  status: SessionStatus;
  iconType: IconType;
  createdAt: string;
  expiryTime: string;
  fiberProvider?: string;
  fiberNetwork?: string;
  fiberSessionId?: string;
  fiberStatus?: string;
  fiberProofId?: string;
  lastChargeProofId?: string;
  autoMicroCharges: boolean;
  singleUse: boolean;
  logs: TransactionLogDto[];
  chargeAttempts: ChargeAttemptDto[];
}

export interface WalletDto {
  connected: boolean;
  address: string;
  authProvider: 'joyid';
  addressType: 'ckb';
  balance: number;
  balanceMinor: number;
  currency: string;
}

export interface SessionsOverviewDto {
  wallet: WalletDto;
  activeSessions: SessionDto[];
  historySessions: SessionDto[];
}

export interface CreateSessionInput {
  name: string;
  serviceAddress: string;
  appId?: string;
  appUrl?: string;
  appTrustLevel?: string;
  appPermissions?: string[];
  chargePolicy?: string;
  paymentPurpose?: PaymentPurpose;
  recipientName?: string;
  recipientAddress?: string;
  recipientWallets?: RecipientWalletDto[];
  paymentReference?: string;
  releaseCadence?: ReleaseCadence;
  nextReleaseAt?: string;
  maxChargeAmount?: number;
  conditionSummary?: string;
  expiryAt?: string;
  platformFeeEstimate?: number;
  networkFeeEstimate?: number;
  limit: number;
  currency: string;
  duration: string;
  expiryTime: string;
  autoMicroCharges: boolean;
  singleUse: boolean;
  iconType: IconType;
}

export interface ChargeSessionInput {
  sessionId: string;
  amount: number;
  type: string;
  appId?: string;
  apiKeyId?: string;
  appOwnerWalletId?: string;
  appServiceAddress?: string;
  chargeOrigin?: 'app_api_key' | 'system';
  idempotencyKey?: string;
  serviceReference?: string;
  paymentRequest?: string;
  deferSingleUseSettlement?: boolean;
  metadata?: Record<string, unknown>;
}

export interface GrantSessionAppInput {
  appId: string;
  appPermissions?: string[];
}

export interface CreateSessionPolicyDto {
  limits: {
    min: number;
    minMinor: number;
    max: number;
    maxMinor: number;
    currency: string;
  };
  expiry: {
    minMinutes: number;
    maxDays: number;
  };
  fees: {
    platformFeeBps: number;
    minPlatformFee: number;
    minPlatformFeeMinor: number;
    estimatedNetworkFee: number;
    estimatedNetworkFeeMinor: number;
  };
  fiber: {
    provider: string;
    network: string;
  };
  verifiedApps: VerifiedAppDto[];
}

export interface WalletIdentity {
  walletId: string;
  address: string;
}

function newPublicId(): string {
  const raw = randomUUID().replace(/-/g, '');
  return 'fp_pass_' + raw.slice(0, 16);
}

function utcTimeLabel(): string {
  return new Date().toISOString().slice(11, 19) + ' UTC';
}

function newLog(type: string, amountMinor = 0, currency: string = CREATE_SESSION_POLICY.currency): TransactionLogDto {
  return {
    id: 'log-' + Date.now() + '-' + randomUUID().slice(0, 8),
    type,
    timestamp: utcTimeLabel(),
    amount: fromMinorUnits(amountMinor, currency),
    amountMinor
  };
}

function prependLogs(
  session: { get: (path: string) => unknown; set: (path: string, value: unknown) => void },
  ...logs: TransactionLogDto[]
): void {
  const existingLogs = (session.get('logs') as TransactionLogDto[] | undefined) ?? [];
  session.set('logs', [...logs, ...existingLogs]);
}

function sessionSpentMinor(session: { spent?: number | null; spentMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(session.spentMinor, session.spent, session.currency ?? CREATE_SESSION_POLICY.currency);
}

function sessionLimitMinor(session: { limit?: number | null; limitMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(session.limitMinor, session.limit, session.currency ?? CREATE_SESSION_POLICY.currency);
}

function walletBalanceMinor(wallet: { balance?: number | null; balanceMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(wallet.balanceMinor, wallet.balance, wallet.currency ?? CREATE_SESSION_POLICY.currency);
}

function toChargeAttemptDto(attempt: ChargeAttemptLike): ChargeAttemptDto {
  const amountMinor = fallbackMinorUnits(attempt.amountMinor, attempt.amount, attempt.currency);
  const resultingSpentMinor = attempt.resultingSpentMinor == null
    ? attempt.resultingSpent == null ? undefined : fallbackMinorUnits(undefined, attempt.resultingSpent, attempt.currency)
    : attempt.resultingSpentMinor;
  const remainingBalanceMinor = attempt.remainingBalanceMinor == null
    ? attempt.remainingBalance == null ? undefined : fallbackMinorUnits(undefined, attempt.remainingBalance, attempt.currency)
    : attempt.remainingBalanceMinor;

  return {
    id: attempt.attemptId,
    sessionId: attempt.sessionId,
    appId: attempt.appId ?? undefined,
    apiKeyId: attempt.apiKeyId ?? undefined,
    amount: fromMinorUnits(amountMinor, attempt.currency),
    amountMinor,
    currency: attempt.currency,
    type: attempt.type,
    status: attempt.status,
    failureCode: attempt.failureCode ?? undefined,
    failureMessage: attempt.failureMessage ?? undefined,
    resultingSpent: resultingSpentMinor == null ? undefined : fromMinorUnits(resultingSpentMinor, attempt.currency),
    resultingSpentMinor,
    remainingBalance: remainingBalanceMinor == null ? undefined : fromMinorUnits(remainingBalanceMinor, attempt.currency),
    remainingBalanceMinor,
    provider: attempt.provider ?? undefined,
    network: attempt.network ?? undefined,
    providerStatus: attempt.providerStatus ?? undefined,
    providerCorrelationId: attempt.providerCorrelationId ?? undefined,
    proofId: attempt.proofId ?? undefined,
    proofType: attempt.proofType ?? undefined,
    executionLayer: attempt.executionLayer ?? undefined,
    reserveStatus: attempt.reserveStatus ?? undefined,
    idempotencyKey: attempt.idempotencyKey ?? undefined,
    serviceReference: attempt.serviceReference ?? undefined,
    paymentRequestHash: attempt.paymentRequestHash ?? undefined,
    explorerUrl: ckbTransactionExplorerUrl(attempt.proofId ?? undefined, attempt.network ?? env.FIBER_NETWORK),
    createdAt: (attempt.createdAt ?? new Date()).toISOString()
  };
}

function toSessionDto(session: SessionLike, chargeAttempts: ChargeAttemptDto[] = []): SessionDto {
  const spentMinor = sessionSpentMinor(session);
  const reservedMinor = session.reservedMinor ?? 0;
  const limitMinor = sessionLimitMinor(session);
  const remainingBalanceMinor = clampMinorUnits(limitMinor - spentMinor - reservedMinor);
  const platformFeeEstimateMinor = fallbackMinorUnits(session.platformFeeEstimateMinor, session.platformFeeEstimate ?? 0, session.currency);
  const networkFeeEstimateMinor = fallbackMinorUnits(session.networkFeeEstimateMinor, session.networkFeeEstimate ?? 0, session.currency);

  return {
    id: session.publicId,
    name: session.name,
    serviceAddress: session.serviceAddress,
    appId: session.appId,
    appUrl: session.appUrl,
    appTrustLevel: session.appTrustLevel,
    appPermissions: session.appPermissions ?? [],
    appGrantOwnerWalletId: session.appGrantOwnerWalletId,
    appGrantCreatedAt: session.appGrantCreatedAt instanceof Date ? session.appGrantCreatedAt.toISOString() : undefined,
    chargePolicy: session.chargePolicy,
    paymentPurpose: session.paymentPurpose ?? 'app_session',
    recipientName: session.recipientName,
    recipientAddress: session.recipientAddress,
    recipientWallets: (session.recipientWallets ?? []).map((wallet) => toSafeRecipientWallet(wallet as RecipientWalletDto)),
    paymentReference: session.paymentReference,
    releaseCadence: session.releaseCadence ?? 'none',
    nextReleaseAt: session.nextReleaseAt instanceof Date ? session.nextReleaseAt.toISOString() : undefined,
    maxChargeAmount: session.maxChargeAmount,
    maxChargeAmountMinor: session.maxChargeAmountMinor,
    conditionSummary: session.conditionSummary,
    expiryAt: session.expiryAt instanceof Date ? session.expiryAt.toISOString() : session.expiryAt,
    platformFeeEstimate: fromMinorUnits(platformFeeEstimateMinor, session.currency),
    platformFeeEstimateMinor,
    networkFeeEstimate: fromMinorUnits(networkFeeEstimateMinor, session.currency),
    networkFeeEstimateMinor,
    spent: fromMinorUnits(spentMinor, session.currency),
    spentMinor,
    reservedBalance: fromMinorUnits(reservedMinor, session.currency),
    reservedBalanceMinor: reservedMinor,
    limit: fromMinorUnits(limitMinor, session.currency),
    limitMinor,
    remainingBalance: fromMinorUnits(remainingBalanceMinor, session.currency),
    remainingBalanceMinor,
    currency: session.currency,
    duration: session.duration,
    status: session.status,
    iconType: session.iconType,
    createdAt: (session.createdAt ?? new Date()).toISOString(),
    expiryTime: session.expiryTime,
    fiberProvider: session.fiberProvider,
    fiberNetwork: session.fiberNetwork,
    fiberSessionId: session.fiberSessionId,
    fiberStatus: session.fiberStatus,
    fiberProofId: session.fiberProofId,
    lastChargeProofId: session.lastChargeProofId,
    autoMicroCharges: session.autoMicroCharges,
    singleUse: session.singleUse,
    logs: (session.logs ?? []).map((log) => ({
      ...log,
      amountMinor: fallbackMinorUnits(log.amountMinor, log.amount, session.currency),
      amount: fromMinorUnits(fallbackMinorUnits(log.amountMinor, log.amount, session.currency), session.currency)
    })),
    chargeAttempts
  };
}

function toWalletDto(wallet: WalletRecord): WalletDto {
  const balanceMinor = walletBalanceMinor(wallet);
  return {
    connected: wallet.connected,
    address: wallet.address,
    authProvider: 'joyid',
    addressType: 'ckb',
    balance: fromMinorUnits(balanceMinor, wallet.currency),
    balanceMinor,
    currency: wallet.currency
  };
}

async function publishOverview(walletId: string): Promise<void> {
  liveEvents.publish('overview:' + walletId, await getSessionsOverview(walletId));
}

export function getCreateSessionPolicy(): CreateSessionPolicyDto {
  return {
    limits: {
      min: CREATE_SESSION_POLICY.minLimit,
      minMinor: toMinorUnits(String(CREATE_SESSION_POLICY.minLimit), CREATE_SESSION_POLICY.currency),
      max: CREATE_SESSION_POLICY.maxLimit,
      maxMinor: toMinorUnits(String(CREATE_SESSION_POLICY.maxLimit), CREATE_SESSION_POLICY.currency),
      currency: CREATE_SESSION_POLICY.currency
    },
    expiry: {
      minMinutes: CREATE_SESSION_POLICY.minExpiryMinutes,
      maxDays: CREATE_SESSION_POLICY.maxExpiryDays
    },
    fees: {
      platformFeeBps: CREATE_SESSION_POLICY.platformFeeBps,
      minPlatformFee: CREATE_SESSION_POLICY.minPlatformFee,
      minPlatformFeeMinor: toMinorUnits(String(CREATE_SESSION_POLICY.minPlatformFee), CREATE_SESSION_POLICY.currency),
      estimatedNetworkFee: CREATE_SESSION_POLICY.estimatedNetworkFee,
      estimatedNetworkFeeMinor: toMinorUnits(String(CREATE_SESSION_POLICY.estimatedNetworkFee), CREATE_SESSION_POLICY.currency)
    },
    fiber: {
      provider: fiberProvider.kind,
      network: fiberProvider.network
    },
    verifiedApps: VERIFIED_APP_CATALOG
  };
}

function getVerifiedApp(appId?: string): VerifiedAppDto | undefined {
  if (!appId || appId === 'manual') return undefined;
  return VERIFIED_APP_CATALOG.find((app) => app.id === appId);
}

const SESSION_APP_PERMISSION_SET = new Set<string>(SESSION_APP_PERMISSIONS);

export function normalizeSessionAppPermissions(
  permissions?: readonly string[] | null,
  defaultChargePermission = false
): SessionAppPermission[] {
  const normalized = (permissions ?? [])
    .map((permission) => permission.trim())
    .filter((permission): permission is SessionAppPermission => SESSION_APP_PERMISSION_SET.has(permission));
  const unique = [...new Set(normalized)];
  return unique.length > 0 || !defaultChargePermission ? unique : ['charges:create'];
}

function validateCreateLimit(limitMinor: number): void {
  const minMinor = toMinorUnits(String(CREATE_SESSION_POLICY.minLimit), CREATE_SESSION_POLICY.currency);
  const maxMinor = toMinorUnits(String(CREATE_SESSION_POLICY.maxLimit), CREATE_SESSION_POLICY.currency);
  if (limitMinor < minMinor || limitMinor > maxMinor) {
    throw new ApiError(
      400,
      'SESSION_LIMIT_OUT_OF_RANGE',
      'FiberPass limit must be between ' + CREATE_SESSION_POLICY.minLimit + ' and ' + CREATE_SESSION_POLICY.maxLimit.toLocaleString('en-US') + ' ' + CREATE_SESSION_POLICY.currency + '.'
    );
  }
}

function validateExpiryAt(expiryAt?: string): Date | undefined {
  if (!expiryAt) return undefined;

  const parsed = new Date(expiryAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, 'INVALID_EXPIRY_TIME', 'Expiry time must be a valid ISO date.');
  }

  const minExpiry = Date.now() + CREATE_SESSION_POLICY.minExpiryMinutes * 60 * 1000;
  const maxExpiry = Date.now() + CREATE_SESSION_POLICY.maxExpiryDays * 24 * 60 * 60 * 1000;
  if (parsed.getTime() < minExpiry || parsed.getTime() > maxExpiry) {
    throw new ApiError(
      400,
      'EXPIRY_OUT_OF_RANGE',
      'Expiry must be at least ' + CREATE_SESSION_POLICY.minExpiryMinutes + ' minutes from now and no more than ' + CREATE_SESSION_POLICY.maxExpiryDays + ' days out.'
    );
  }

  return parsed;
}

function estimatePlatformFeeMinor(limitMinor: number): number {
  return Math.max(toMinorUnits(String(CREATE_SESSION_POLICY.minPlatformFee), CREATE_SESSION_POLICY.currency), Math.ceil(limitMinor * (CREATE_SESSION_POLICY.platformFeeBps / 10000)));
}

function cleanOptionalString(value?: string): string | undefined {
  const cleaned = (value ?? '').trim();
  return cleaned ? cleaned : undefined;
}

function validateFiberPaymentRequest(value?: string): string | undefined {
  const request = cleanOptionalString(value);
  if (!request) return undefined;
  if (request.length < MIN_FIBER_PAYMENT_REQUEST_LENGTH || /\s/.test(request)) {
    throw new ApiError(400, 'INVALID_FIBER_PAYMENT_REQUEST', 'Enter a full Fiber invoice/payment request; short placeholders cannot be paid.');
  }
  return request;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newMagicToken(): string {
  return randomBytes(32).toString('hex');
}

function publicAppUrl(): string {
  return (env.PUBLIC_APP_URL || env.FRONTEND_ORIGIN.split(',')[0] || 'http://localhost:3000').replace(/\/$/, '');
}

function recipientClaimUrl(token: string): string {
  return publicAppUrl() + '/recipient-claim/' + encodeURIComponent(token);
}

function inviteExpiryDate(): Date {
  return new Date(Date.now() + env.RECIPIENT_MAGIC_LINK_TTL_HOURS * 60 * 60 * 1000);
}

interface PreparedRecipientInvite {
  index: number;
  token: string;
  email: string;
  expiresAt: Date;
}

function prepareRecipientInvites(wallets: RecipientWalletDto[]): { wallets: RecipientWalletDto[]; invites: PreparedRecipientInvite[] } {
  const invites: PreparedRecipientInvite[] = [];
  const preparedWallets = wallets.map((wallet, index) => {
    if (!wallet.email || wallet.address || wallet.fiberInvoice) return wallet;
    const token = newMagicToken();
    const expiresAt = inviteExpiryDate();
    invites.push({ index, token, email: wallet.email, expiresAt });
    return {
      ...wallet,
      status: 'awaiting_details' as const,
      inviteStatus: 'pending' as const,
      inviteTokenHash: sha256(token),
      inviteTokenExpiresAt: expiresAt,
      payoutNotificationStatus: 'pending' as const
    };
  });
  return { wallets: preparedWallets, invites };
}

function toSafeRecipientWallet(wallet: RecipientWalletDto): RecipientWalletDto {
  const { inviteTokenHash: _inviteTokenHash, ...safeWallet } = wallet;
  return safeWallet;
}

async function sendSessionRecipientInvites(session: SessionRecord & { createdAt?: Date }, invites: PreparedRecipientInvite[]): Promise<void> {
  for (const invite of invites) {
    const wallet = (session.recipientWallets ?? [])[invite.index] as RecipientWalletDto | undefined;
    if (!wallet?.email) continue;
    try {
      await sendRecipientInviteEmail({
        to: invite.email,
        recipientName: wallet.name,
        payerName: session.name,
        passName: session.name,
        amountMinor: fallbackMinorUnits(wallet.amountMinor, wallet.amount, session.currency),
        currency: session.currency,
        claimUrl: recipientClaimUrl(invite.token),
        expiresAt: invite.expiresAt,
        expectedPaymentAt: session.nextReleaseAt instanceof Date ? session.nextReleaseAt : undefined,
        reference: session.paymentReference ?? undefined,
        conditionSummary: session.conditionSummary ?? undefined,
        timeZone: wallet.recipientTimeZone
      });
      await SessionModel.updateOne(
        { publicId: session.publicId },
        {
          $set: {
            ['recipientWallets.' + invite.index + '.inviteStatus']: 'sent',
            ['recipientWallets.' + invite.index + '.inviteSentAt']: new Date()
          },
          $unset: { ['recipientWallets.' + invite.index + '.inviteLastFailure']: 1 }
        }
      );
    } catch (error) {
      await SessionModel.updateOne(
        { publicId: session.publicId },
        {
          $set: {
            ['recipientWallets.' + invite.index + '.inviteStatus']: 'send_failed',
            ['recipientWallets.' + invite.index + '.inviteLastFailure']: error instanceof Error ? error.message : 'Email send failed.'
          }
        }
      );
    }
  }
}

export interface RecipientClaimDto {
  tokenValid: boolean;
  status: 'pending' | 'claimed' | 'expired' | 'not_found';
  recipientName?: string;
  recipientEmail?: string;
  amount?: number;
  amountMinor?: number;
  currency?: string;
  payerName?: string;
  passName?: string;
  expectedPaymentAt?: string;
  expiresAt?: string;
  reference?: string;
  conditionSummary?: string;
  recipientTimeZone?: string;
  hasAddress?: boolean;
  hasFiberInvoice?: boolean;
}

function normalizeTimeZone(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 80) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return undefined;
  }
}

function recipientClaimDto(input: { session: SessionRecord; wallet: RecipientWalletDto; expired: boolean }): RecipientClaimDto {
  const { session, wallet, expired } = input;
  const claimed = Boolean((wallet.address || wallet.fiberInvoice) && wallet.inviteClaimedAt);
  const amountMinor = fallbackMinorUnits(wallet.amountMinor, wallet.amount, session.currency);
  return {
    tokenValid: !expired,
    status: expired ? 'expired' : claimed ? 'claimed' : 'pending',
    recipientName: wallet.name,
    recipientEmail: wallet.email,
    amount: fromMinorUnits(amountMinor, session.currency),
    amountMinor,
    currency: session.currency,
    payerName: session.name,
    passName: session.name,
    expectedPaymentAt: session.nextReleaseAt instanceof Date ? session.nextReleaseAt.toISOString() : undefined,
    expiresAt: wallet.inviteTokenExpiresAt instanceof Date ? wallet.inviteTokenExpiresAt.toISOString() : undefined,
    reference: session.paymentReference ?? undefined,
    conditionSummary: session.conditionSummary ?? undefined,
    recipientTimeZone: wallet.recipientTimeZone,
    hasAddress: Boolean(wallet.address),
    hasFiberInvoice: Boolean(wallet.fiberInvoice)
  };
}

async function findRecipientClaim(token: string): Promise<{ session: SessionRecord & { save: () => Promise<unknown>; set: (path: string, value: unknown) => void }; wallet: RecipientWalletDto; index: number; expired: boolean } | null> {
  const tokenHash = sha256(token);
  const session = await SessionModel.findOne({ 'recipientWallets.inviteTokenHash': tokenHash });
  if (!session) return null;
  const wallets = (session.recipientWallets ?? []) as RecipientWalletDto[];
  const index = wallets.findIndex((wallet) => wallet.inviteTokenHash === tokenHash);
  if (index < 0) return null;
  const wallet = wallets[index];
  const expiresAt = wallet.inviteTokenExpiresAt instanceof Date ? wallet.inviteTokenExpiresAt : wallet.inviteTokenExpiresAt ? new Date(wallet.inviteTokenExpiresAt) : undefined;
  const expired = Boolean(expiresAt && expiresAt.getTime() <= Date.now());
  if (expired && wallet.inviteStatus !== 'expired' && !wallet.inviteClaimedAt) {
    session.set('recipientWallets.' + index + '.inviteStatus', 'expired');
    await session.save();
  }
  return { session: session as unknown as SessionRecord & { save: () => Promise<unknown>; set: (path: string, value: unknown) => void }, wallet, index, expired };
}

export async function getRecipientClaim(token: string): Promise<RecipientClaimDto> {
  const claim = await findRecipientClaim(token);
  if (!claim) return { tokenValid: false, status: 'not_found' };
  return recipientClaimDto(claim);
}

export async function claimRecipientWallet(token: string, input: { address?: string; fiberInvoice?: string }, timeZone?: string): Promise<RecipientClaimDto> {
  const address = cleanOptionalString(input.address);
  const fiberInvoice = validateFiberPaymentRequest(input.fiberInvoice);
  if (!address && !fiberInvoice) {
    throw new ApiError(400, 'RECIPIENT_DESTINATION_REQUIRED', 'Add a CKB wallet address or Fiber invoice/payment request before this payout can be released.');
  }
  if (address && !isFiberCkbAddress(address)) {
    throw new ApiError(400, 'INVALID_RECIPIENT_ADDRESS', FIBER_CKB_ADDRESS_ERROR);
  }
  const claim = await findRecipientClaim(token);
  if (!claim) throw new ApiError(404, 'RECIPIENT_CLAIM_NOT_FOUND', 'This FiberPass payment link was not found.');
  if (claim.expired) throw new ApiError(410, 'RECIPIENT_CLAIM_EXPIRED', 'This FiberPass payment link has expired.');

  if (address) claim.session.set('recipientWallets.' + claim.index + '.address', address);
  if (fiberInvoice) claim.session.set('recipientWallets.' + claim.index + '.fiberInvoice', fiberInvoice);
  claim.session.set('recipientWallets.' + claim.index + '.status', 'pending');
  claim.session.set('recipientWallets.' + claim.index + '.inviteStatus', 'claimed');
  const recipientTimeZone = normalizeTimeZone(timeZone);
  if (recipientTimeZone) claim.session.set('recipientWallets.' + claim.index + '.recipientTimeZone', recipientTimeZone);
  claim.session.set('recipientWallets.' + claim.index + '.inviteClaimedAt', new Date());
  await claim.session.save();
  void runScheduledLiquidityPreparation({
    ownerWalletId: claim.session.ownerWalletId as string,
    sessionId: claim.session.publicId,
    limit: 1
  }).catch(() => undefined);
  await publishOverview(claim.session.ownerWalletId as string).catch(() => undefined);

  const refreshed = await findRecipientClaim(token);
  if (!refreshed) throw new ApiError(404, 'RECIPIENT_CLAIM_NOT_FOUND', 'This FiberPass payment link was not found.');
  return recipientClaimDto(refreshed);
}

function normalizePaymentPurpose(value?: PaymentPurpose): PaymentPurpose {
  return value && isValidPaymentPurpose(value) ? value : 'app_session';
}

function defaultReleaseCadence(purpose: PaymentPurpose): ReleaseCadence {
  if (purpose === 'subscription') return 'monthly';
  if (purpose === 'recurring_release') return 'monthly';
  return 'none';
}

function normalizeReleaseCadence(value: ReleaseCadence | undefined, purpose: PaymentPurpose): ReleaseCadence {
  if (!value || !isValidReleaseCadence(value)) return defaultReleaseCadence(purpose);
  if (purpose === 'app_session' || purpose === 'scheduled_release') return 'none';
  if (value === 'none') return defaultReleaseCadence(purpose);
  return value;
}

function validateNextReleaseAt(value: string | undefined, purpose: PaymentPurpose, expiryAt?: Date): Date | undefined {
  const requiresDate = purpose === 'subscription' || purpose === 'scheduled_release' || purpose === 'recurring_release';
  const cleaned = cleanOptionalString(value);
  if (!cleaned) {
    if (requiresDate) {
      throw new ApiError(400, 'RELEASE_DATE_REQUIRED', 'Choose when the reserved funds should auto-release.');
    }
    return undefined;
  }

  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, 'INVALID_RELEASE_DATE', 'Release date must be a valid ISO date.');
  }

  if (parsed.getTime() <= Date.now()) {
    throw new ApiError(400, 'RELEASE_DATE_IN_PAST', 'Release date must be in the future.');
  }

  if (expiryAt && parsed.getTime() > expiryAt.getTime()) {
    throw new ApiError(400, 'RELEASE_AFTER_EXPIRY', 'Release date must be before the FiberPass expiry.');
  }

  return parsed;
}

function normalizeEmail(value?: string): string | undefined {
  const email = cleanOptionalString(value)?.toLowerCase();
  if (!email) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'INVALID_RECIPIENT_EMAIL', 'Enter a valid recipient email address.');
  }
  return email;
}

function normalizeRecipientWallets(input: {
  purpose: PaymentPurpose;
  recipientName?: string;
  recipientAddress?: string;
  recipientWallets?: RecipientWalletDto[];
}): RecipientWalletDto[] {
  const requiresRecipient = input.purpose === 'subscription' || input.purpose === 'scheduled_release' || input.purpose === 'recurring_release';
  const candidates = (input.recipientWallets ?? [])
    .map((wallet) => ({
      name: cleanOptionalString(wallet.name) ?? '',
      address: cleanOptionalString(wallet.address) ?? '',
      email: normalizeEmail(wallet.email),
      amount: wallet.amount,
      amountMinor: wallet.amountMinor,
      fiberInvoice: validateFiberPaymentRequest(wallet.fiberInvoice),
      status: wallet.status
    }))
    .filter((wallet) => wallet.name || wallet.address || wallet.email || wallet.amount != null || wallet.fiberInvoice);

  const legacyName = cleanOptionalString(input.recipientName);
  const legacyAddress = cleanOptionalString(input.recipientAddress);
  if (candidates.length === 0 && (legacyName || legacyAddress)) {
    candidates.push({ name: legacyName ?? 'Recipient', address: legacyAddress ?? '', email: undefined, amount: undefined, amountMinor: undefined, fiberInvoice: undefined, status: 'pending' as const });
  }

  if (requiresRecipient && candidates.length === 0) {
    throw new ApiError(400, 'RECIPIENT_WALLETS_REQUIRED', 'Add at least one recipient wallet or email for this payment rule.');
  }

  if (candidates.length > 25) {
    throw new ApiError(400, 'TOO_MANY_RECIPIENT_WALLETS', 'A FiberPass payment rule can include up to 25 recipients.');
  }

  const seenAddresses = new Set<string>();
  const seenEmails = new Set<string>();
  const seenFiberInvoices = new Set<string>();
  const wallets: RecipientWalletDto[] = [];
  for (const wallet of candidates) {
    if (!wallet.name) {
      throw new ApiError(400, 'RECIPIENT_NAME_REQUIRED', 'Each recipient needs a label.');
    }
    if (!wallet.address && !wallet.email && !wallet.fiberInvoice) {
      throw new ApiError(400, 'RECIPIENT_DESTINATION_REQUIRED', 'Each recipient needs a CKB wallet address, Fiber invoice/payment request, or an email invite to collect details.');
    }
    if (wallet.address && !isFiberCkbAddress(wallet.address)) {
      throw new ApiError(400, 'INVALID_RECIPIENT_ADDRESS', FIBER_CKB_ADDRESS_ERROR);
    }
    const amountMinor = wallet.amountMinor ?? (wallet.amount == null ? undefined : toMinorUnits(String(wallet.amount), CREATE_SESSION_POLICY.currency));
    if (requiresRecipient && (amountMinor == null || amountMinor <= 0)) {
      throw new ApiError(400, 'RECIPIENT_AMOUNT_REQUIRED', 'Each scheduled payout recipient needs a payout amount.');
    }
    if (wallet.address) {
      const normalizedAddress = wallet.address.toLowerCase();
      if (seenAddresses.has(normalizedAddress)) {
        throw new ApiError(400, 'DUPLICATE_RECIPIENT_WALLET', 'Recipient wallet addresses must be unique in a payment rule.');
      }
      seenAddresses.add(normalizedAddress);
    }
    if (wallet.email) {
      if (seenEmails.has(wallet.email)) {
        throw new ApiError(400, 'DUPLICATE_RECIPIENT_EMAIL', 'Recipient email addresses must be unique in a payment rule.');
      }
      seenEmails.add(wallet.email);
    }
    if (wallet.fiberInvoice) {
      if (seenFiberInvoices.has(wallet.fiberInvoice)) {
        throw new ApiError(400, 'DUPLICATE_RECIPIENT_FIBER_INVOICE', 'Fiber payment requests must be unique in a payment rule.');
      }
      seenFiberInvoices.add(wallet.fiberInvoice);
    }
    const status = wallet.address || wallet.fiberInvoice ? 'pending' : 'awaiting_details';
    wallets.push({
      name: wallet.name,
      address: wallet.address,
      email: wallet.email,
      amount: amountMinor == null ? undefined : fromMinorUnits(amountMinor, CREATE_SESSION_POLICY.currency),
      amountMinor,
      fiberInvoice: wallet.fiberInvoice,
      status,
      inviteStatus: wallet.email && !wallet.address && !wallet.fiberInvoice ? 'pending' : 'not_required',
      payoutNotificationStatus: wallet.email ? 'pending' : 'not_required'
    });
  }

  return wallets;
}

function resolveMaxChargeAmountMinor(input: CreateSessionInput, purpose: PaymentPurpose, limitMinor: number): number | undefined {
  if (input.maxChargeAmount == null) {
    return purpose === 'app_session' ? undefined : limitMinor;
  }

  const maxChargeAmountMinor = toMinorUnits(String(input.maxChargeAmount), input.currency);
  if (maxChargeAmountMinor <= 0) {
    throw new ApiError(400, 'INVALID_MAX_CHARGE_AMOUNT', 'Maximum auto payment amount must be greater than zero.');
  }
  if (maxChargeAmountMinor > limitMinor) {
    throw new ApiError(400, 'MAX_CHARGE_EXCEEDS_LIMIT', 'Maximum auto payment amount cannot exceed the pass limit.');
  }
  return maxChargeAmountMinor;
}

function cadenceLabel(cadence: ReleaseCadence): string {
  switch (cadence) {
    case 'daily': return 'daily';
    case 'weekly': return 'weekly';
    case 'monthly': return 'monthly';
    case 'custom': return 'on the custom schedule';
    case 'on_demand': return 'when the service requests payment';
    default: return 'once';
  }
}

function buildSessionChargePolicy(input: {
  purpose: PaymentPurpose;
  fallbackPolicy?: string;
  maxChargeAmountMinor?: number;
  currency: string;
  releaseCadence: ReleaseCadence;
  recipientName?: string;
  recipientCount?: number;
  nextReleaseAt?: Date;
}): string | undefined {
  if (input.purpose === 'app_session') return cleanOptionalString(input.fallbackPolicy);
  const maxAmount = input.maxChargeAmountMinor == null ? undefined : fromMinorUnits(input.maxChargeAmountMinor, input.currency).toLocaleString('en-US') + ' ' + input.currency;
  if (input.purpose === 'subscription') {
    return 'Subscription can auto-charge ' + (maxAmount ? 'up to ' + maxAmount + ' ' : '') + cadenceLabel(input.releaseCadence) + ' while the pass is active.';
  }
  if (input.purpose === 'scheduled_release') {
    const recipient = input.recipientCount && input.recipientCount > 1 ? ' to ' + input.recipientCount + ' wallets' : input.recipientName ? ' to ' + input.recipientName : '';
    return 'Reserved vault funds auto-release once' + recipient + ' on the scheduled date through Fiber Network.';
  }
  const recipient = input.recipientCount && input.recipientCount > 1 ? ' to ' + input.recipientCount + ' wallets' : input.recipientName ? ' to ' + input.recipientName : '';
  return 'Recurring reserved vault funds auto-release ' + cadenceLabel(input.releaseCadence) + recipient + ' through Fiber Network.';
}

function metadataString(metadata: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

const APP_RESTRICTED_CHARGE_METADATA = [
  'scheduledPayout',
  'directVaultPayout',
  'payoutRail',
  'fiberKeysendTargetPubkey',
  'fiberAllowSelfPayment',
  'fiberPaymentTimeoutSeconds',
  'fiberMaxFeeAmountMinor',
  'fiberPaymentChunkIndex',
  'fiberPaymentTotalAmountMinor',
  'fiberExitInvoice'
] as const;

export function sanitizeChargeMetadata(input: ChargeSessionInput): Record<string, unknown> {
  const metadata = { ...(input.metadata ?? {}) };
  if (input.chargeOrigin === 'app_api_key') {
    for (const key of APP_RESTRICTED_CHARGE_METADATA) delete metadata[key];
  }
  return metadata;
}

function addressesMatch(left?: string, right?: string): boolean {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
}

function ruleMaxChargeMinor(session: { maxChargeAmountMinor?: number | null; maxChargeAmount?: number | null; currency?: string | null }): number | undefined {
  if (session.maxChargeAmountMinor != null) return session.maxChargeAmountMinor;
  if (session.maxChargeAmount != null) return fallbackMinorUnits(undefined, session.maxChargeAmount, session.currency ?? CREATE_SESSION_POLICY.currency);
  return undefined;
}

export function assertChargeAllowedBySessionRules(session: SessionRecord, input: ChargeSessionInput, amountMinor: number): void {
  const purpose = normalizePaymentPurpose(session.paymentPurpose as PaymentPurpose | undefined);
  const maxChargeMinor = ruleMaxChargeMinor(session);
  if (maxChargeMinor != null && amountMinor > maxChargeMinor) {
    throw new ApiError(402, 'PAYMENT_RULE_AMOUNT_EXCEEDED', 'Charge exceeds this FiberPass payment rule maximum.');
  }

  const reference = cleanOptionalString(session.paymentReference as string | undefined);
  if (reference) {
    const requestReference = chargeServiceReference(input);
    if (!requestReference) {
      throw new ApiError(403, 'PAYMENT_REFERENCE_REQUIRED', 'This FiberPass requires its configured payment reference.');
    }
    if (requestReference !== reference) {
      throw new ApiError(403, 'PAYMENT_REFERENCE_MISMATCH', 'Charge reference does not match this FiberPass rule.');
    }
  }

  const allowedRecipientAddresses = (session.recipientWallets ?? [])
    .map((wallet) => cleanOptionalString(wallet.address))
    .filter((address): address is string => Boolean(address));
  const legacyRecipientAddress = cleanOptionalString(session.recipientAddress as string | undefined);
  if (allowedRecipientAddresses.length === 0 && legacyRecipientAddress) {
    allowedRecipientAddresses.push(legacyRecipientAddress);
  }
  if (allowedRecipientAddresses.length > 0) {
    const requestRecipient = metadataString(input.metadata, 'recipientAddress', 'recipientServiceAddress', 'payeeAddress');
    if (!requestRecipient || !allowedRecipientAddresses.some((address) => addressesMatch(address, requestRecipient))) {
      throw new ApiError(403, 'RECIPIENT_MISMATCH', 'Charge recipient does not match any wallet authorized by this FiberPass rule.');
    }
  }

  if (purpose === 'subscription' || purpose === 'scheduled_release' || purpose === 'recurring_release') {
    const nextReleaseAt = session.nextReleaseAt instanceof Date ? session.nextReleaseAt : undefined;
    if (nextReleaseAt && nextReleaseAt.getTime() > Date.now()) {
      throw new ApiError(409, 'RELEASE_NOT_DUE', 'Reserved funds are not due for release yet.');
    }
  }
}

function advanceReleaseDate(current: Date | undefined, cadence?: ReleaseCadence): Date | undefined {
  const next = current ? new Date(current) : new Date();
  switch (cadence) {
    case 'daily':
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    case 'weekly':
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case 'monthly':
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    default:
      return undefined;
  }
}

export function walletIdFromAddress(address: string): string {
  return address.toLowerCase();
}

export async function reconcileWalletBalanceWithCurrentVault(walletId: string): Promise<void> {
  const vault = deriveVaultForWallet({ walletId });
  if (!vault) {
    await ensureWalletMoneyFields(walletId);
    return;
  }

  const [wallet, sessions, fundingRecords] = await Promise.all([
    WalletModel.findOne({ walletId }).select('balance balanceMinor currency').lean<{ balance?: number | null; balanceMinor?: number | null; currency?: string | null }>(),
    SessionModel.find({ ownerWalletId: walletId }).select('status limit limitMinor spent spentMinor currency').lean<Array<{ status?: string | null; limit?: number | null; limitMinor?: number | null; spent?: number | null; spentMinor?: number | null; currency?: string | null }>>(),
    WalletFundingModel.find({
      walletId,
      status: 'confirmed',
      depositMode: 'vault',
      vaultScriptHash: vault.scriptHash
    }).select('amount amountMinor currency').lean<Array<{ amount?: number | null; amountMinor?: number | null; currency?: string | null }>>()
  ]);

  if (!wallet) return;

  const fundedMinor = fundingRecords.reduce((total, funding) => {
    return total + fallbackMinorUnits(funding.amountMinor, funding.amount, funding.currency ?? CREATE_SESSION_POLICY.currency);
  }, 0);
  const spentMinor = sessions.reduce((total, session) => {
    return total + fallbackMinorUnits(session.spentMinor, session.spent, session.currency ?? CREATE_SESSION_POLICY.currency);
  }, 0);
  const reservedMinor = sessions.reduce((total, session) => {
    if (!OPEN_STATUSES.includes(session.status as SessionStatus)) return total;
    const currency = session.currency ?? CREATE_SESSION_POLICY.currency;
    const limitMinor = fallbackMinorUnits(session.limitMinor, session.limit, currency);
    const sessionSpentMinor = fallbackMinorUnits(session.spentMinor, session.spent, currency);
    return total + clampMinorUnits(limitMinor - sessionSpentMinor);
  }, 0);

  let availableMinor = fundedMinor > 0
    ? clampMinorUnits(fundedMinor - spentMinor - reservedMinor)
    : walletBalanceMinor(wallet);

  try {
    const liveCells = await listLiveVaultCells({ lock: vault.script, limit: 500 });
    const liveCapacityMinor = liveCells.reduce((total, cell) => total + cell.capacityShannons, 0);
    const liveAvailableMinor = clampMinorUnits(liveCapacityMinor - reservedMinor);
    if (fundedMinor > 0) {
      availableMinor = Math.min(availableMinor, liveAvailableMinor);
    } else if (liveCapacityMinor > 0) {
      availableMinor = liveAvailableMinor;
    }
  } catch {
    // Keep the ledger-derived balance when the indexer is unavailable.
  }

  await WalletModel.updateOne(
    { walletId },
    {
      $set: {
        currency: CREATE_SESSION_POLICY.currency,
        balanceMinor: availableMinor,
        balance: fromMinorUnits(availableMinor, CREATE_SESSION_POLICY.currency)
      }
    }
  );
}

async function ensureWalletMoneyFields(walletId: string): Promise<void> {
  const wallet = await WalletModel.findOne({ walletId });
  if (!wallet) return;
  const balanceMinor = walletBalanceMinor(wallet.toObject());
  if (wallet.balanceMinor !== balanceMinor || wallet.balance !== fromMinorUnits(balanceMinor, wallet.currency)) {
    wallet.balanceMinor = balanceMinor;
    wallet.balance = fromMinorUnits(balanceMinor, wallet.currency);
    await wallet.save();
  }
}

async function resetUntouchedLegacyPlaceholderBalance(walletId: string): Promise<void> {
  const wallet = await WalletModel.findOne({ walletId });
  if (!wallet) return;

  const balanceMinor = walletBalanceMinor(wallet.toObject());
  if (balanceMinor !== LEGACY_PLACEHOLDER_BALANCE_MINOR) return;

  const [sessionCount, fundingCount] = await Promise.all([
    SessionModel.countDocuments({ ownerWalletId: walletId }),
    WalletFundingModel.countDocuments({ walletId })
  ]);

  if (sessionCount > 0 || fundingCount > 0) return;

  wallet.balanceMinor = 0;
  wallet.balance = 0;
  await wallet.save();
}

export async function ensureWalletForAddress(address: string): Promise<WalletRecord> {
  const walletId = walletIdFromAddress(address);
  const wallet = await WalletModel.findOneAndUpdate(
    { walletId },
    {
      $set: { connected: true, address },
      $setOnInsert: {
        walletId,
        balance: 0,
        balanceMinor: 0,
        currency: CREATE_SESSION_POLICY.currency
      }
    },
    { upsert: true, new: true }
  );

  await resetUntouchedLegacyPlaceholderBalance(walletId);

  const currentWallet = await WalletModel.findOne({ walletId });
  if (!currentWallet) {
    throw new ApiError(404, 'WALLET_NOT_FOUND', 'Connect with JoyID before loading FiberPass sessions.');
  }

  await reconcileWalletBalanceWithCurrentVault(walletId);
  const reconciledWallet = await WalletModel.findOne({ walletId });
  if (!reconciledWallet) {
    throw new ApiError(404, 'WALLET_NOT_FOUND', 'Connect with JoyID before loading FiberPass sessions.');
  }

  return reconciledWallet.toObject();
}

async function getWalletDocument(walletId: string) {
  await reconcileWalletBalanceWithCurrentVault(walletId);
  await resetUntouchedLegacyPlaceholderBalance(walletId);
  const wallet = await WalletModel.findOne({ walletId });
  if (!wallet) {
    throw new ApiError(404, 'WALLET_NOT_FOUND', 'Connect with JoyID before loading FiberPass sessions.');
  }
  return wallet;
}


function fiberProviderFailure(error: unknown, code: string, fallbackMessage: string): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  return new ApiError(502, code, message);
}

function localFiberResult(): { provider: typeof fiberProvider.kind; network: string; proofId: string } {
  return { provider: fiberProvider.kind, network: fiberProvider.network, proofId: '' };
}

async function topUpFiberSessionIfOpen(input: {
  session: { fiberSessionId?: string | null; currency: string };
  publicId: string;
  walletId: string;
  amountMinor: number;
}): Promise<{ provider: typeof fiberProvider.kind; network: string; proofId: string }> {
  if (!input.session.fiberSessionId) return localFiberResult();
  try {
    return await fiberProvider.topUpSession({
      sessionId: input.publicId,
      networkSessionId: input.session.fiberSessionId,
      walletId: input.walletId,
      amountMinor: input.amountMinor,
      currency: input.session.currency
    });
  } catch (error) {
    throw fiberProviderFailure(error, 'FIBER_TOP_UP_FAILED', 'Fiber top up failed.');
  }
}

async function settleFiberSessionIfOpen(input: {
  session: { fiberSessionId?: string | null };
  publicId: string;
  amountMinor: number;
  currency: string;
  reason: 'revoked' | 'settled' | 'expired';
}): Promise<{ provider: typeof fiberProvider.kind; network: string; proofId: string }> {
  if (!input.session.fiberSessionId) return localFiberResult();
  try {
    const result = input.reason === 'revoked'
      ? await fiberProvider.revokeSession({
          sessionId: input.publicId,
          networkSessionId: input.session.fiberSessionId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          reason: input.reason
        })
      : await fiberProvider.settleSession({
          sessionId: input.publicId,
          networkSessionId: input.session.fiberSessionId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          reason: input.reason
        });
    return { provider: result.provider, network: result.network, proofId: result.proofId };
  } catch (error) {
    throw fiberProviderFailure(error, 'FIBER_SETTLEMENT_FAILED', 'Fiber settlement failed.');
  }
}

async function getSessionOrThrow(publicId: string, walletId?: string) {
  const session = await SessionModel.findOne({
    publicId,
    ...(walletId ? { ownerWalletId: walletId } : {})
  });
  if (!session) {
    throw new ApiError(404, 'SESSION_NOT_FOUND', 'FiberPass session was not found.');
  }
  return session;
}

export async function getSessionsOverview(walletId: string): Promise<SessionsOverviewDto> {
  const [wallet, sessions] = await Promise.all([
    getWalletDocument(walletId),
    SessionModel.find({ ownerWalletId: walletId }).sort({ createdAt: -1 }).lean<SessionLike[]>()
  ]);

  const sessionIds = sessions.map((session) => session.publicId);
  const attempts = sessionIds.length === 0
    ? []
    : await ChargeAttemptModel.find({ sessionId: { $in: sessionIds } }).sort({ createdAt: -1 }).limit(200).lean<ChargeAttemptLike[]>();
  const attemptsBySession = new Map<string, ChargeAttemptDto[]>();
  for (const attempt of attempts) {
    const existing = attemptsBySession.get(attempt.sessionId) ?? [];
    if (existing.length < 20) {
      existing.push(toChargeAttemptDto(attempt));
      attemptsBySession.set(attempt.sessionId, existing);
    }
  }

  const sessionDtos = sessions.map((session) => toSessionDto(session, attemptsBySession.get(session.publicId) ?? []));
  return {
    wallet: toWalletDto(wallet.toObject()),
    activeSessions: sessionDtos.filter((session) => OPEN_STATUSES.includes(session.status)),
    historySessions: sessionDtos.filter((session) => HISTORY_STATUSES.includes(session.status))
  };
}

export async function createSession(input: CreateSessionInput, walletId: string): Promise<SessionsOverviewDto> {
  const limitMinor = toMinorUnits(String(input.limit), input.currency);
  validateCreateLimit(limitMinor);

  if (input.currency !== CREATE_SESSION_POLICY.currency) {
    throw new ApiError(400, 'UNSUPPORTED_CURRENCY', 'FiberPass currently supports ' + CREATE_SESSION_POLICY.currency + ' sessions.');
  }

  const requestedAppId = cleanOptionalString(input.appId);
  const verifiedApp = getVerifiedApp(requestedAppId);
  const registeredApp = requestedAppId && requestedAppId !== 'manual'
    ? await AppModel.findOne({ appId: requestedAppId, ownerWalletId: walletId, status: 'active' }).lean<AppRecord | null>()
    : null;
  if (requestedAppId && requestedAppId !== 'manual' && !verifiedApp && !registeredApp) {
    throw new ApiError(403, 'APP_GRANT_NOT_ALLOWED', 'Only an active app owned by this wallet can be granted access to a FiberPass.');
  }

  await reconcileWalletBalanceWithCurrentVault(walletId);

  const expiryAt = validateExpiryAt(input.expiryAt);
  const paymentPurpose = normalizePaymentPurpose(input.paymentPurpose);
  const normalizedRecipientWallets = normalizeRecipientWallets({
    purpose: paymentPurpose,
    recipientName: input.recipientName,
    recipientAddress: input.recipientAddress,
    recipientWallets: input.recipientWallets
  });
  const preparedRecipients = prepareRecipientInvites(normalizedRecipientWallets);
  if (preparedRecipients.invites.length > 0) {
    requireEmailConfigured();
  }
  const recipientWallets = preparedRecipients.wallets;
  const primaryRecipient = recipientWallets[0];
  const recipientName = primaryRecipient?.name ?? cleanOptionalString(input.recipientName);
  const recipientAddress = primaryRecipient?.address ?? cleanOptionalString(input.recipientAddress);
  const releaseCadence = normalizeReleaseCadence(input.releaseCadence, paymentPurpose);
  const nextReleaseAt = validateNextReleaseAt(input.nextReleaseAt, paymentPurpose, expiryAt);
  const maxChargeAmountMinor = resolveMaxChargeAmountMinor(input, paymentPurpose, limitMinor);
  const maxChargeAmount = maxChargeAmountMinor == null ? undefined : fromMinorUnits(maxChargeAmountMinor, input.currency);
  const paymentReference = cleanOptionalString(input.paymentReference);
  const conditionSummary = cleanOptionalString(input.conditionSummary);
  const effectiveAutoMicroCharges = paymentPurpose === 'app_session' ? input.autoMicroCharges : true;
  const effectiveSingleUse = paymentPurpose === 'scheduled_release' && recipientWallets.length <= 1 ? true : paymentPurpose === 'app_session' ? input.singleUse : false;
  const publicId = newPublicId();
  const resolvedAppId = registeredApp?.appId ?? verifiedApp?.id ?? requestedAppId;
  const serviceAddress = registeredApp?.serviceAddress ?? verifiedApp?.serviceAddress ?? input.serviceAddress;
  const appPermissions = normalizeSessionAppPermissions(
    registeredApp ? input.appPermissions : verifiedApp?.permissions ?? input.appPermissions,
    Boolean(registeredApp)
  );
  const platformFeeEstimateMinor = estimatePlatformFeeMinor(limitMinor);
  const networkFeeEstimateMinor = toMinorUnits(String(CREATE_SESSION_POLICY.estimatedNetworkFee), input.currency);
  const limit = fromMinorUnits(limitMinor, input.currency);
  const chargePolicy = buildSessionChargePolicy({
    purpose: paymentPurpose,
    fallbackPolicy: verifiedApp?.chargePolicy ?? input.chargePolicy,
    maxChargeAmountMinor,
    currency: input.currency,
    releaseCadence,
    recipientName,
    recipientCount: recipientWallets.length,
    nextReleaseAt
  });

  const wallet = await WalletModel.findOneAndUpdate(
    { walletId, balanceMinor: { $gte: limitMinor } },
    { $inc: { balanceMinor: -limitMinor, balance: -limit } },
    { new: true }
  );

  if (!wallet) {
    throw new ApiError(400, 'INSUFFICIENT_WALLET_BALANCE', 'Wallet balance is too low for this FiberPass limit.');
  }

  try {
    const createdSession = await SessionModel.create({
      ownerWalletId: walletId,
      publicId,
      name: registeredApp?.name ?? verifiedApp?.name ?? input.name,
      serviceAddress,
      appId: resolvedAppId,
      appUrl: registeredApp?.url ?? verifiedApp?.url ?? input.appUrl,
      appTrustLevel: registeredApp ? 'owner-approved' : verifiedApp?.trustLevel ?? input.appTrustLevel,
      appPermissions,
      appGrantOwnerWalletId: registeredApp ? walletId : undefined,
      appGrantCreatedAt: registeredApp ? new Date() : undefined,
      chargePolicy,
      paymentPurpose,
      recipientName,
      recipientAddress,
      recipientWallets,
      paymentReference,
      releaseCadence,
      nextReleaseAt,
      maxChargeAmount,
      maxChargeAmountMinor,
      conditionSummary,
      expiryAt,
      platformFeeEstimate: fromMinorUnits(platformFeeEstimateMinor, input.currency),
      platformFeeEstimateMinor,
      networkFeeEstimate: fromMinorUnits(networkFeeEstimateMinor, input.currency),
      networkFeeEstimateMinor,
      spent: 0,
      spentMinor: 0,
      limit,
      limitMinor,
      currency: input.currency,
      duration: input.duration,
      status: 'active',
      iconType: verifiedApp?.iconType ?? input.iconType,
      expiryTime: expiryAt ? expiryAt.toISOString() : input.expiryTime,
      fiberProvider: fiberProvider.kind,
      fiberNetwork: fiberProvider.network,
      fiberStatus: 'active',
      autoMicroCharges: effectiveAutoMicroCharges,
      singleUse: effectiveSingleUse,
      logs: [newLog(paymentPurpose === 'app_session' ? 'Session Stream Limit Created' : 'Payment Rule Reserve Created')]
    });

    await sendSessionRecipientInvites(createdSession.toObject() as SessionRecord, preparedRecipients.invites);
    await writeAuditLog({ actorWalletId: walletId, action: 'session.created', targetType: 'session', targetId: publicId, metadata: { limitMinor, appId: resolvedAppId, appGrantCreated: Boolean(registeredApp), paymentPurpose, releaseCadence, nextReleaseAt, recipientInviteCount: preparedRecipients.invites.length } });
    void runScheduledLiquidityPreparation({ ownerWalletId: walletId, sessionId: publicId, limit: 1 }).catch(() => undefined);
  } catch (error) {
    await WalletModel.updateOne({ walletId }, { $inc: { balanceMinor: limitMinor, balance: limit } });
    throw error;
  }

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}

export async function grantAppAccessToSession(
  publicId: string,
  walletId: string,
  input: GrantSessionAppInput
): Promise<SessionsOverviewDto> {
  const [session, app] = await Promise.all([
    getSessionOrThrow(publicId, walletId),
    AppModel.findOne({ appId: input.appId, ownerWalletId: walletId, status: 'active' })
  ]);
  if (!app) {
    throw new ApiError(403, 'APP_GRANT_NOT_ALLOWED', 'Only an active app owned by this wallet can be granted access to a FiberPass.');
  }
  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Only active or paused sessions can receive an app grant.');
  }

  const appPermissions = normalizeSessionAppPermissions(input.appPermissions, true);
  session.appId = app.appId;
  session.serviceAddress = app.serviceAddress;
  session.appUrl = app.url;
  session.appTrustLevel = 'owner-approved';
  session.appPermissions = appPermissions;
  session.appGrantOwnerWalletId = walletId;
  session.appGrantCreatedAt = new Date();
  prependLogs(session, newLog('App Charge Access Granted'));
  await session.save();

  await writeAuditLog({
    actorWalletId: walletId,
    action: 'session.app_grant.created',
    targetType: 'session',
    targetId: publicId,
    metadata: { appId: app.appId, appPermissions }
  });
  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}

export async function resendRecipientInvites(publicId: string, walletId: string): Promise<SessionsOverviewDto> {
  const session = await getSessionOrThrow(publicId, walletId);
  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Only active or paused sessions can resend recipient invites.');
  }

  const wallets = (session.recipientWallets ?? []) as RecipientWalletDto[];
  const candidateIndexes = wallets
    .map((wallet, index) => ({ wallet, index }))
    .filter(({ wallet }) => Boolean(wallet.email && !wallet.address && !wallet.fiberInvoice && wallet.status !== 'paid' && wallet.inviteStatus !== 'claimed'));

  if (candidateIndexes.length === 0) {
    throw new ApiError(409, 'NO_RECIPIENT_INVITES_TO_RESEND', 'There are no pending recipient email invites to resend for this pass.');
  }

  requireEmailConfigured();

  const invites: PreparedRecipientInvite[] = [];
  for (const { wallet, index } of candidateIndexes) {
    const token = newMagicToken();
    const expiresAt = inviteExpiryDate();
    invites.push({ index, token, email: wallet.email as string, expiresAt });
    session.set('recipientWallets.' + index + '.inviteTokenHash', sha256(token));
    session.set('recipientWallets.' + index + '.inviteTokenExpiresAt', expiresAt);
    session.set('recipientWallets.' + index + '.inviteStatus', 'pending');
    session.set('recipientWallets.' + index + '.inviteLastFailure', undefined);
    session.set('recipientWallets.' + index + '.status', 'awaiting_details');
  }

  await session.save();
  await sendSessionRecipientInvites(session.toObject() as SessionRecord, invites);
  await writeAuditLog({ actorWalletId: walletId, action: 'session.recipient_invites_resent', targetType: 'session', targetId: publicId, metadata: { recipientInviteCount: invites.length } });

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}

export async function topUpSession(publicId: string, walletId: string, amount = 1): Promise<SessionsOverviewDto> {
  const session = await getSessionOrThrow(publicId, walletId);
  const topUpMinor = toMinorUnits(String(amount), session.currency);
  if (topUpMinor <= 0) {
    throw new ApiError(400, 'INVALID_TOP_UP_AMOUNT', 'Top up amount must be greater than zero.');
  }

  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Only active or paused sessions can be topped up.');
  }

  await reconcileWalletBalanceWithCurrentVault(walletId);
  const topUpAmount = fromMinorUnits(topUpMinor, session.currency);
  const wallet = await WalletModel.findOneAndUpdate(
    { walletId, balanceMinor: { $gte: topUpMinor } },
    { $inc: { balanceMinor: -topUpMinor, balance: -topUpAmount } },
    { new: true }
  );

  if (!wallet) {
    throw new ApiError(400, 'INSUFFICIENT_WALLET_BALANCE', 'Wallet balance is too low for this top up.');
  }

  try {
    const result = await topUpFiberSessionIfOpen({
      session,
      publicId,
      walletId,
      amountMinor: topUpMinor
    });

    const nextLimitMinor = sessionLimitMinor(session.toObject()) + topUpMinor;
    session.limitMinor = nextLimitMinor;
    session.limit = fromMinorUnits(nextLimitMinor, session.currency);
    session.fiberProvider = result.provider;
    session.fiberNetwork = result.network;
    session.fiberProofId = result.proofId;
    prependLogs(session, newLog('Session Allocation Top Up', topUpMinor, session.currency));
    await session.save();
    await writeAuditLog({ actorWalletId: walletId, action: 'session.top_up', targetType: 'session', targetId: publicId, metadata: { amountMinor: topUpMinor, proofId: result.proofId } });
  } catch (error) {
    await WalletModel.updateOne({ walletId }, { $inc: { balanceMinor: topUpMinor, balance: topUpAmount } });
    throw error;
  }

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}

export async function togglePauseSession(publicId: string, walletId: string): Promise<SessionsOverviewDto> {
  const session = await getSessionOrThrow(publicId, walletId);
  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Only active or paused sessions can be paused or resumed.');
  }

  session.status = session.status === 'paused' ? 'active' : 'paused';
  session.fiberStatus = session.status === 'paused' ? 'paused' : 'active';
  prependLogs(session, newLog(session.status === 'active' ? 'Session Stream Resumed' : 'Session Stream Paused'));
  await session.save();
  await writeAuditLog({ actorWalletId: walletId, action: session.status === 'active' ? 'session.resumed' : 'session.paused', targetType: 'session', targetId: publicId });

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}

export async function revokeSession(publicId: string, walletId: string): Promise<SessionsOverviewDto> {
  const session = await getSessionOrThrow(publicId, walletId);
  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Session is already closed.');
  }

  const refundMinor = clampMinorUnits(sessionLimitMinor(session.toObject()) - sessionSpentMinor(session.toObject()));
  const refundAmount = fromMinorUnits(refundMinor, session.currency);
  const result = await settleFiberSessionIfOpen({
    session,
    publicId,
    amountMinor: refundMinor,
    currency: session.currency,
    reason: 'revoked'
  });

  session.status = 'revoked';
  session.fiberProvider = result.provider;
  session.fiberNetwork = result.network;
  session.fiberStatus = 'revoked';
  session.fiberProofId = result.proofId;
  session.expiryTime = 'Revoked by Owner';
  prependLogs(session, newLog('Session Revoked (Refunded ' + refundAmount.toLocaleString('en-US') + ' ' + session.currency + ')'));
  await session.save();

  await WalletModel.updateOne({ walletId }, { $inc: { balanceMinor: refundMinor, balance: refundAmount } });
  await writeAuditLog({ actorWalletId: walletId, action: 'session.revoked', targetType: 'session', targetId: publicId, metadata: { refundMinor, proofId: result.proofId } });

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}

export async function settleSession(publicId: string, walletId: string): Promise<SessionsOverviewDto> {
  const session = await getSessionOrThrow(publicId, walletId);
  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Session is already closed.');
  }

  const refundMinor = clampMinorUnits(sessionLimitMinor(session.toObject()) - sessionSpentMinor(session.toObject()));
  const refundAmount = fromMinorUnits(refundMinor, session.currency);
  const result = await settleFiberSessionIfOpen({
    session,
    publicId,
    amountMinor: refundMinor,
    currency: session.currency,
    reason: 'settled'
  });

  session.status = 'settled';
  session.fiberProvider = result.provider;
  session.fiberNetwork = result.network;
  session.fiberStatus = 'settled';
  session.fiberProofId = result.proofId;
  session.expiryTime = 'Settled by User';
  prependLogs(session, newLog('Session Settled (Refunded ' + refundAmount.toLocaleString('en-US') + ' ' + session.currency + ')'));
  await session.save();

  await WalletModel.updateOne({ walletId }, { $inc: { balanceMinor: refundMinor, balance: refundAmount } });
  await writeAuditLog({ actorWalletId: walletId, action: 'session.settled', targetType: 'session', targetId: publicId, metadata: { refundMinor, proofId: result.proofId } });

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}

function normalizedAddress(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}

export function assertDirectAppChargeAuthorized(session: SessionRecord, input: ChargeSessionInput): void {
  if (input.chargeOrigin !== 'app_api_key') return;
  if (!input.appId || !input.appOwnerWalletId) {
    throw new ApiError(403, 'APP_AUTH_CONTEXT_REQUIRED', 'Authenticated app ownership is required to charge a FiberPass.');
  }
  if (session.ownerWalletId !== input.appOwnerWalletId) {
    throw new ApiError(403, 'APP_OWNER_MISMATCH', 'An app can only charge passes owned by the same wallet.');
  }
  if (
    !session.appGrantOwnerWalletId
    || !session.appGrantCreatedAt
    || !session.appId
    || session.appId === 'manual'
  ) {
    throw new ApiError(403, 'APP_SESSION_GRANT_REQUIRED', 'The pass owner must explicitly grant this app charge access.');
  }
  if (session.appGrantOwnerWalletId !== input.appOwnerWalletId) {
    throw new ApiError(403, 'APP_GRANT_OWNER_MISMATCH', 'The app grant belongs to a different wallet.');
  }
  if (session.appId !== input.appId) {
    throw new ApiError(403, 'APP_SESSION_MISMATCH', 'This FiberPass is granted to a different app.');
  }
  if (normalizedAddress(session.serviceAddress) !== normalizedAddress(input.appServiceAddress)) {
    throw new ApiError(403, 'APP_SERVICE_ADDRESS_MISMATCH', 'The app service address changed; the pass owner must renew the grant.');
  }
  if (!session.autoMicroCharges) {
    throw new ApiError(403, 'APP_CHARGES_DISABLED', 'This FiberPass only allows owner-controlled charges.');
  }
  if (!normalizeSessionAppPermissions(session.appPermissions).includes('charges:create')) {
    throw new ApiError(403, 'APP_SESSION_PERMISSION_REQUIRED', 'This FiberPass does not grant the app permission to create charges.');
  }
}

export function assertChargePreflight(session: SessionRecord, input: ChargeSessionInput, amountMinor: number): void {
  assertDirectAppChargeAuthorized(session, input);
  if (session.status !== 'active') {
    throw new ApiError(409, 'SESSION_NOT_CHARGEABLE', 'Session is ' + session.status + '; charges are blocked.');
  }
  assertChargeAllowedBySessionRules(session, input, amountMinor);
}

function failureFromError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'CHARGE_FAILED', message: error.message };
  }
  return { code: 'CHARGE_FAILED', message: 'Charge attempt failed.' };
}

async function writeChargeFailureAudit(input: {
  request: ChargeSessionInput;
  ownerWalletId: string;
  amountMinor: number;
  error: ApiError;
}): Promise<void> {
  await writeAuditLog({
    actorWalletId: input.request.appOwnerWalletId ?? input.ownerWalletId,
    action: input.error.statusCode < 500 ? 'charge.denied' : 'charge.failed',
    targetType: 'session',
    targetId: input.request.sessionId,
    metadata: {
      appId: input.request.appId,
      apiKeyId: input.request.apiKeyId,
      sessionOwnerWalletId: input.ownerWalletId,
      amountMinor: input.amountMinor,
      failureCode: input.error.code
    }
  });
}

function chargeIdempotencyKey(input: ChargeSessionInput): string | undefined {
  return cleanOptionalString(input.idempotencyKey)
    ?? metadataString(input.metadata, 'idempotencyKey', 'idempotency_key', 'externalId', 'invoiceId', 'jobId', 'paymentJobId');
}

function chargeServiceReference(input: ChargeSessionInput): string | undefined {
  return cleanOptionalString(input.serviceReference)
    ?? metadataString(input.metadata, 'serviceReference', 'paymentReference', 'subscriptionId', 'externalReference', 'invoiceReference');
}

function chargePaymentRequest(input: ChargeSessionInput): string | undefined {
  return cleanOptionalString(input.paymentRequest)
    ?? metadataString(input.metadata, 'fiberInvoice', 'paymentRequest', 'invoice');
}

function safeFiberPaymentRequestHash(paymentRequest?: string): string | undefined {
  if (!paymentRequest) return undefined;
  try {
    return hashFiberPaymentRequest(paymentRequest);
  } catch {
    return undefined;
  }
}

export function chargeRequestFingerprint(input: {
  sessionId: string;
  amountMinor: number;
  currency: string;
  appId?: string;
  serviceReference?: string;
  paymentRequestHash?: string;
  executionLayer: 'fiber' | 'ckb-vault';
  recipientAddress?: string;
  providerTarget?: string;
}): string {
  return createHash('sha256').update(JSON.stringify({
    sessionId: input.sessionId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    appId: input.appId ?? null,
    serviceReference: input.serviceReference ?? null,
    paymentRequestHash: input.paymentRequestHash ?? null,
    executionLayer: input.executionLayer,
    recipientAddress: input.recipientAddress?.trim().toLowerCase() ?? null,
    providerTarget: input.providerTarget?.trim().toLowerCase() ?? null
  })).digest('hex');
}

function assertIdempotentChargeReplay(input: {
  attempt: ChargeAttemptLike;
  sessionId: string;
  amountMinor: number;
  currency: string;
  requestFingerprint: string;
}): void {
  const existingAmountMinor = fallbackMinorUnits(input.attempt.amountMinor, input.attempt.amount, input.attempt.currency);
  if (
    input.attempt.sessionId !== input.sessionId
    || existingAmountMinor !== input.amountMinor
    || input.attempt.currency !== input.currency
    || (input.attempt.requestFingerprint && input.attempt.requestFingerprint !== input.requestFingerprint)
  ) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different charge request.');
  }
}

function utcDayStart(date = new Date()): Date {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export async function assertDailySessionSpendLimit(sessionId: string, amountMinor: number, currency: string): Promise<void> {
  const dailyLimitMinor = toMinorUnits(String(env.FIBERPASS_DAILY_SESSION_SPEND_LIMIT_CKB), currency);
  if (amountMinor > dailyLimitMinor) {
    throw new ApiError(429, 'DAILY_SESSION_LIMIT_EXCEEDED', 'Charge exceeds the daily FiberPass spend limit.');
  }

  const [dailyExposure] = await ChargeAttemptModel.aggregate<{ totalMinor?: number }>([
    {
      $match: {
        sessionId,
        currency,
        status: 'succeeded',
        createdAt: { $gte: utcDayStart() }
      }
    },
    { $group: { _id: null, totalMinor: { $sum: '$amountMinor' } } }
  ]);
  const spentTodayMinor = dailyExposure?.totalMinor ?? 0;

  if (spentTodayMinor + amountMinor > dailyLimitMinor) {
    throw new ApiError(429, 'DAILY_SESSION_LIMIT_EXCEEDED', 'Daily FiberPass spend limit reached for this pass.');
  }
}

export async function chargeSession(input: ChargeSessionInput): Promise<SessionsOverviewDto> {
  const amountMinor = toMinorUnits(String(input.amount), CREATE_SESSION_POLICY.currency);
  if (amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_CHARGE_AMOUNT', 'Charge amount must be greater than zero.');
  }

  const chargeInput: ChargeSessionInput = { ...input, metadata: sanitizeChargeMetadata(input) };
  let session = await getSessionOrThrow(input.sessionId);
  const ownerWalletId = session.ownerWalletId as string;
  const currency = session.currency;
  const sessionObject = session.toObject();
  const isScheduledPayout = chargeInput.metadata?.scheduledPayout === true;
  const directVaultPayout = chargeInput.metadata?.directVaultPayout === true;
  const idempotencyKey = chargeIdempotencyKey(chargeInput);
  const serviceReference = chargeServiceReference(chargeInput);
  const paymentRequest = chargePaymentRequest(chargeInput);
  const recipientAddress = metadataString(chargeInput.metadata, 'recipientAddress', 'recipientServiceAddress', 'payeeAddress');
  const providerTarget = metadataString(chargeInput.metadata, 'fiberKeysendTargetPubkey');
  const executionLayer = directVaultPayout ? 'ckb-vault' : 'fiber';
  const paymentRequestHash = directVaultPayout ? undefined : safeFiberPaymentRequestHash(paymentRequest);
  const requestFingerprint = chargeRequestFingerprint({
    sessionId: input.sessionId,
    amountMinor,
    currency,
    appId: input.appId,
    serviceReference,
    paymentRequestHash,
    executionLayer,
    recipientAddress,
    providerTarget
  });
  const baseAttemptMetadata = {
    ...(chargeInput.metadata ?? {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(serviceReference ? { serviceReference } : {}),
    ...(paymentRequest ? { fiberInvoice: paymentRequest } : {})
  };

  try {
    if (!idempotencyKey) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Every charge source must provide a stable idempotency key.');
    }
    assertChargePreflight(sessionObject as SessionRecord, { ...chargeInput, metadata: baseAttemptMetadata }, amountMinor);
    if (directVaultPayout && !recipientAddress) {
      throw new ApiError(400, 'RECIPIENT_ADDRESS_REQUIRED', 'Direct vault payout requires a recipient CKB address.');
    }
  } catch (error) {
    const publicError = error instanceof ApiError
      ? error
      : new ApiError(500, 'CHARGE_PREFLIGHT_FAILED', 'Charge authorization failed.');
    await writeChargeFailureAudit({ request: input, ownerWalletId, amountMinor, error: publicError });
    throw publicError;
  }

  const expiryAt = session.expiryAt instanceof Date ? session.expiryAt : undefined;
  if (expiryAt && expiryAt.getTime() <= Date.now() && !isScheduledPayout) {
    session.status = 'expired';
    session.fiberStatus = 'expired';
    session.expiryTime = 'Expired';
    prependLogs(session, newLog('Charge Blocked - Session Expired'));
    await session.save();
    await publishOverview(ownerWalletId);
    const error = new ApiError(410, 'SESSION_EXPIRED', 'Session has expired; charges are blocked.');
    await writeChargeFailureAudit({ request: input, ownerWalletId, amountMinor, error });
    throw error;
  }

  const completeCharge = async (attemptId: string, charge: ProviderChargeResult): Promise<SessionsOverviewDto> => {
    try {
      await finalizeChargeReservation(attemptId);
    } catch (error) {
      throw new ApiError(503, 'CHARGE_FINALIZATION_PENDING', 'The provider payment succeeded and is awaiting database finalization.', {
        attemptId,
        cause: error instanceof Error ? error.message : 'unknown'
      });
    }

    session = await getSessionOrThrow(input.sessionId);
    const refreshed = session.toObject() as SessionRecord;
    const nextSpentMinor = sessionSpentMinor(refreshed);
    const limitMinor = sessionLimitMinor(refreshed);
    prependLogs(session, newLog(input.type, amountMinor, currency));

    if (nextSpentMinor >= limitMinor) {
      const result = await settleFiberSessionIfOpen({
        session,
        publicId: input.sessionId,
        amountMinor: 0,
        currency,
        reason: 'expired'
      });
      session.status = 'expired';
      session.fiberStatus = 'expired';
      session.fiberProofId = result.proofId;
      session.expiryTime = 'Limit Exhausted';
      prependLogs(session, newLog('Spending Limit Exhausted - Settled'));
    } else if (session.singleUse && !input.deferSingleUseSettlement) {
      const refundMinor = clampMinorUnits(limitMinor - nextSpentMinor);
      const refundAmount = fromMinorUnits(refundMinor, currency);
      const result = await settleFiberSessionIfOpen({
        session,
        publicId: input.sessionId,
        amountMinor: refundMinor,
        currency,
        reason: 'settled'
      });
      session.status = 'settled';
      session.fiberStatus = 'settled';
      session.fiberProofId = result.proofId;
      session.expiryTime = 'Single-use charge completed';
      prependLogs(session, newLog('Single-use Session Settled (Refunded ' + refundAmount.toLocaleString('en-US') + ' ' + currency + ')'));
      await WalletModel.updateOne({ walletId: ownerWalletId }, { $inc: { balanceMinor: refundMinor, balance: refundAmount } });
    } else {
      session.fiberStatus = 'active';
      const recipientWalletCount = Array.isArray(session.recipientWallets) ? session.recipientWallets.length : 0;
      const canAdvanceReleaseDate = !isScheduledPayout && (session.paymentPurpose !== 'recurring_release' || recipientWalletCount <= 1);
      const advancedReleaseAt = canAdvanceReleaseDate
        ? advanceReleaseDate(
            session.nextReleaseAt instanceof Date ? session.nextReleaseAt : undefined,
            session.releaseCadence as ReleaseCadence | undefined
          )
        : undefined;
      if (advancedReleaseAt) session.nextReleaseAt = advancedReleaseAt;
    }

    await session.save();
    const completedSpentMinor = sessionSpentMinor(session.toObject());
    const remainingBalanceMinor = clampMinorUnits(sessionLimitMinor(session.toObject()) - completedSpentMinor);
    await ChargeAttemptModel.updateOne(
      { attemptId, status: 'succeeded', reserveStatus: 'debited' },
      {
        $set: {
          resultingSpent: fromMinorUnits(completedSpentMinor, currency),
          resultingSpentMinor: completedSpentMinor,
          remainingBalance: fromMinorUnits(remainingBalanceMinor, currency),
          remainingBalanceMinor
        }
      }
    );
    await reconcileWalletBalanceWithCurrentVault(ownerWalletId);
    await writeAuditLog({ actorWalletId: ownerWalletId, action: 'charge.succeeded', targetType: 'session', targetId: input.sessionId, metadata: { appId: input.appId, amountMinor, proofId: charge.proofId, proofType: charge.proofType, executionLayer: charge.executionLayer, paymentPurpose: session.paymentPurpose, recipientAddress: session.recipientAddress } });

    const overview = await getSessionsOverview(ownerWalletId);
    liveEvents.publish('overview:' + ownerWalletId, overview);
    return overview;
  };

  const recoverProviderOutcome = async (attempt: ChargeAttemptLike): Promise<SessionsOverviewDto> => {
    if (attempt.providerStatus === 'succeeded') {
      const charge: ProviderChargeResult = {
        provider: attempt.provider ?? fiberProvider.kind,
        network: attempt.network ?? fiberProvider.network,
        proofId: attempt.proofId ?? attempt.providerCorrelationId ?? '',
        proofType: attempt.proofType ?? 'fiber_payment',
        executionLayer: attempt.executionLayer,
        paymentRequestHash: attempt.paymentRequestHash ?? undefined
      };
      return completeCharge(attempt.attemptId, charge);
    }
    if ((attempt.providerStatus === 'submitted' || attempt.providerStatus === 'uncertain') && attempt.executionLayer === 'fiber') {
      const correlationId = attempt.providerCorrelationId ?? '';
      let payment;
      try {
        payment = await fiberAdapter.reconcilePayment(correlationId);
      } catch (error) {
        throw new ApiError(503, 'CHARGE_OUTCOME_UNCERTAIN', 'The Fiber payment outcome must be reconciled before retrying.', {
          attemptId: attempt.attemptId,
          cause: error instanceof Error ? error.message : 'unknown'
        });
      }
      if (payment.status === 'Success') {
        const charge: ProviderChargeResult = {
          provider: payment.provider,
          network: payment.network,
          proofId: payment.paymentHash,
          proofType: 'fiber_payment',
          executionLayer: 'fiber',
          paymentRequestHash: attempt.paymentRequestHash ?? undefined
        };
        await markChargeProviderSucceeded(attempt.attemptId, charge);
        return completeCharge(attempt.attemptId, charge);
      }
      if (payment.status === 'Failed') {
        const message = payment.failure || 'Fiber payment failed before settlement.';
        await releaseChargeReservation(attempt.attemptId, 'FIBER_PAYMENT_FAILED', message);
        throw new ApiError(502, 'FIBER_PAYMENT_FAILED', message);
      }
      throw new ApiError(409, 'CHARGE_ATTEMPT_PENDING', 'The Fiber payment is still in progress.', { attemptId: attempt.attemptId });
    }
    throw new ApiError(503, 'CHARGE_OUTCOME_UNCERTAIN', 'The provider outcome must be reconciled before retrying.', {
      attemptId: attempt.attemptId
    });
  };

  const existingAttempt = await ChargeAttemptModel.findOne({ sessionId: input.sessionId, idempotencyKey }).lean<ChargeAttemptLike | null>();
  if (existingAttempt) {
    assertIdempotentChargeReplay({ attempt: existingAttempt, sessionId: input.sessionId, amountMinor, currency, requestFingerprint });
    if (existingAttempt.status === 'succeeded') return getSessionsOverview(ownerWalletId);
    if (existingAttempt.status === 'failed') {
      throw new ApiError(409, 'CHARGE_ATTEMPT_FAILED', existingAttempt.failureMessage ?? 'This idempotent charge already failed.', {
        failureCode: existingAttempt.failureCode
      });
    }
    if (existingAttempt.providerStatus !== 'not_started') {
      return recoverProviderOutcome(existingAttempt);
    }
  }

  const attemptId = existingAttempt?.attemptId ?? randomUUID();
  let leaseId = randomUUID();
  const fiberInput = {
    sessionId: input.sessionId,
    networkSessionId: session.fiberSessionId ?? undefined,
    appAddress: session.serviceAddress,
    amountMinor,
    currency,
    paymentRequest,
    metadata: { ...baseAttemptMetadata, chargeAttemptId: attemptId }
  };
  let providerCorrelationId = executionLayer + ':' + attemptId;
  const attemptMetadata = {
    ...baseAttemptMetadata,
    chargeAttemptId: attemptId,
    providerCorrelationId
  };

  let attempt = existingAttempt;
  let ownsExecutionLease = false;
  if (!attempt) {
    try {
      const reservation = await reserveChargeAttempt({
        attemptId,
        sessionId: input.sessionId,
        ownerWalletId,
        appId: input.appId,
        apiKeyId: input.apiKeyId,
        idempotencyKey: idempotencyKey!,
        requestFingerprint,
        serviceReference,
        amount: fromMinorUnits(amountMinor, currency),
        amountMinor,
        currency,
        type: input.type,
        executionLayer,
        paymentRequestHash,
        providerCorrelationId,
        metadata: attemptMetadata,
        dailyLimitMinor: toMinorUnits(String(env.FIBERPASS_DAILY_SESSION_SPEND_LIMIT_CKB), currency),
        executionLeaseId: leaseId,
        sessionMatch: {
          ...(input.chargeOrigin === 'app_api_key' ? {
              appId: input.appId,
              appGrantOwnerWalletId: input.appOwnerWalletId,
              appGrantCreatedAt: { $exists: true },
              appPermissions: 'charges:create',
              autoMicroCharges: true,
              serviceAddress: session.serviceAddress
            } : {}),
          ...(!isScheduledPayout ? {
            $and: [{
              $or: [
                { expiryAt: { $exists: false } },
                { expiryAt: null },
                { expiryAt: { $gt: new Date() } }
              ]
            }]
          } : {})
        }
      });
      attempt = reservation.attempt;
      ownsExecutionLease = reservation.created;
      if (!reservation.created) {
        assertIdempotentChargeReplay({ attempt, sessionId: input.sessionId, amountMinor, currency, requestFingerprint });
      }
    } catch (error) {
      let publicError: ApiError;
      if (error instanceof ChargeReservationError && error.code === 'DAILY_RESERVATION_REJECTED') {
        publicError = new ApiError(429, 'DAILY_SESSION_LIMIT_EXCEEDED', 'Daily FiberPass spend limit reached for this pass.');
      } else if (error instanceof ChargeReservationError) {
        const latest = await getSessionOrThrow(input.sessionId);
        const latestObject = latest.toObject() as SessionRecord;
        const latestExpiryAt = latest.expiryAt instanceof Date ? latest.expiryAt : undefined;
        if (latestExpiryAt && latestExpiryAt.getTime() <= Date.now() && !isScheduledPayout) {
          publicError = new ApiError(410, 'SESSION_EXPIRED', 'Session expired before the charge could be reserved.');
          await writeChargeFailureAudit({ request: input, ownerWalletId, amountMinor, error: publicError });
          throw publicError;
        }
        try {
          assertChargePreflight(latestObject, { ...chargeInput, metadata: baseAttemptMetadata }, amountMinor);
        } catch (preflightError) {
          publicError = preflightError instanceof ApiError
            ? preflightError
            : new ApiError(409, 'CHARGE_RESERVATION_REJECTED', error.message);
          await writeChargeFailureAudit({ request: input, ownerWalletId, amountMinor, error: publicError });
          throw publicError;
        }
        publicError = new ApiError(402, 'SESSION_LIMIT_EXCEEDED', 'Charge exceeds the pass balance available after pending reservations.');
      } else {
        publicError = new ApiError(503, 'CHARGE_RESERVATION_FAILED', error instanceof Error ? error.message : 'Charge reservation failed.');
      }
      await writeChargeFailureAudit({ request: input, ownerWalletId, amountMinor, error: publicError });
      throw publicError;
    }
  }

  if (!attempt) throw new ApiError(503, 'CHARGE_RESERVATION_FAILED', 'Charge reservation did not return an attempt.');
  if (attempt.status === 'succeeded') return getSessionsOverview(ownerWalletId);
  if (attempt.status === 'failed') {
    throw new ApiError(409, 'CHARGE_ATTEMPT_FAILED', attempt.failureMessage ?? 'This idempotent charge already failed.');
  }
  if (attempt.providerStatus !== 'not_started') return recoverProviderOutcome(attempt);

  if (existingAttempt) {
    leaseId = randomUUID();
    const claimed = await claimChargeExecution(attempt.attemptId, leaseId);
    if (!claimed) {
      throw new ApiError(409, 'CHARGE_ATTEMPT_PENDING', 'A worker already owns this idempotent charge attempt.', { attemptId: attempt.attemptId });
    }
    attempt = claimed;
    ownsExecutionLease = true;
  }
  if (!ownsExecutionLease) {
    throw new ApiError(409, 'CHARGE_ATTEMPT_PENDING', 'A worker already owns this idempotent charge attempt.', { attemptId: attempt.attemptId });
  }

  let preparedPayment;
  try {
    preparedPayment = directVaultPayout ? undefined : await fiberAdapter.preparePayment(fiberInput);
  } catch (error) {
    const publicError = error instanceof ApiError
      ? error
      : new ApiError(502, 'FIBER_PAYMENT_FAILED', error instanceof Error ? error.message : 'Fiber payment preparation failed.');
    await releaseChargeReservation(attempt.attemptId, publicError.code, publicError.message);
    await writeChargeFailureAudit({ request: input, ownerWalletId, amountMinor, error: publicError });
    throw publicError;
  }
  providerCorrelationId = preparedPayment?.providerCorrelationId ?? providerCorrelationId;
  const correlated = await setChargeProviderCorrelation({
    attemptId: attempt.attemptId,
    leaseId,
    providerCorrelationId,
    paymentRequestHash: preparedPayment?.paymentRequestHash
  });
  if (!correlated) {
    throw new ApiError(409, 'CHARGE_ATTEMPT_PENDING', 'The charge attempt correlation is already owned by another worker.', { attemptId: attempt.attemptId });
  }

  const submitted = await markChargeProviderSubmitted(attempt.attemptId, leaseId);
  if (!submitted) {
    throw new ApiError(409, 'CHARGE_ATTEMPT_PENDING', 'The charge attempt is already being submitted.', { attemptId: attempt.attemptId });
  }

  let charge: ProviderChargeResult;
  try {
    if (directVaultPayout) {
      const vaultCharge = await executeVaultPayout({
        ownerWalletId,
        sessionId: input.sessionId,
        recipientAddress: recipientAddress!,
        amountMinor,
        currency
      });
      charge = { ...vaultCharge, proofType: 'ckb_transaction', executionLayer: 'ckb-vault' };
    } else {
      const fiberCharge = await fiberAdapter.executePayment(fiberInput, preparedPayment);
      charge = {
        provider: fiberCharge.provider,
        network: fiberCharge.network,
        proofId: fiberCharge.proofId,
        proofType: fiberCharge.proofType,
        executionLayer: 'fiber',
        paymentRequestHash: fiberCharge.paymentRequestHash
      };
    }
  } catch (error) {
    if (!directVaultPayout && /^0x[0-9a-fA-F]{64}$/.test(providerCorrelationId)) {
      let reconciledPayment;
      try {
        reconciledPayment = await fiberAdapter.reconcilePayment(providerCorrelationId);
      } catch {
        reconciledPayment = undefined;
      }
      if (reconciledPayment?.status === 'Success') {
        charge = {
          provider: reconciledPayment.provider,
          network: reconciledPayment.network,
          proofId: reconciledPayment.paymentHash,
          proofType: 'fiber_payment',
          executionLayer: 'fiber',
          paymentRequestHash: preparedPayment?.paymentRequestHash
        };
        await markChargeProviderSucceeded(attempt.attemptId, charge);
        return completeCharge(attempt.attemptId, charge);
      }
      if (reconciledPayment?.status === 'Failed') {
        const message = reconciledPayment.failure || (error instanceof Error ? error.message : 'Fiber payment failed.');
        await releaseChargeReservation(attempt.attemptId, 'FIBER_PAYMENT_FAILED', message);
        throw new ApiError(502, 'FIBER_PAYMENT_FAILED', message);
      }
    }
    const message = error instanceof Error ? error.message : 'Provider payment outcome is unknown.';
    await markChargeOutcomeUncertain(attempt.attemptId, 'CHARGE_OUTCOME_UNCERTAIN', message);
    const publicError = new ApiError(503, 'CHARGE_OUTCOME_UNCERTAIN', 'The provider outcome must be reconciled before retrying.', { attemptId: attempt.attemptId });
    await writeChargeFailureAudit({ request: input, ownerWalletId, amountMinor, error: publicError });
    throw publicError;
  }

  const persistedProviderSuccess = await markChargeProviderSucceeded(attempt.attemptId, charge);
  if (!persistedProviderSuccess) {
    const publicError = new ApiError(503, 'CHARGE_OUTCOME_UNCERTAIN', 'Provider success could not be persisted; reconciliation is required.', { attemptId: attempt.attemptId });
    await writeChargeFailureAudit({ request: input, ownerWalletId, amountMinor, error: publicError });
    throw publicError;
  }
  return completeCharge(attempt.attemptId, charge);
}


interface DueSessionPayoutWorkerInput {
  limit?: number;
  ownerWalletId?: string;
}

export interface DueSessionPayoutWorkerResult {
  scanned: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface PayoutReceiptNotificationWorkerResult {
  scanned: number;
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

function dueWalletAmountMinor(wallet: RecipientWalletDto, currency: string): number {
  return fallbackMinorUnits(wallet.amountMinor, wallet.amount, currency);
}

function earlierRecipientHasInFlightLiquidity(wallets: RecipientWalletDto[], recipientIndex: number): boolean {
  return wallets.slice(0, recipientIndex).some((wallet) => {
    if (wallet.status === 'paid') return false;
    if (wallet.status === 'processing') return true;
    if (wallet.fiberLiquidityBridgeTxHash || wallet.fiberChannelOpenProofId) return true;
    return PENDING_PAYOUT_FAILURE_CODES.includes(wallet.lastFailureCode as typeof PENDING_PAYOUT_FAILURE_CODES[number]);
  });
}

function isRetryableVaultConfigFailure(code?: string): boolean {
  return !!code && (RETRYABLE_VAULT_CONFIG_FAILURE_CODES as readonly string[]).includes(code);
}

function isRetryableVaultTxFailure(code?: string, message?: string): boolean {
  return code === 'VAULT_PAYOUT_TX_FAILED' && new RegExp(RETRYABLE_VAULT_TX_FAILURE_PATTERN).test(message ?? '');
}

function isRetryableVaultFailure(wallet: RecipientWalletDto): boolean {
  return isRetryableVaultConfigFailure(wallet.lastFailureCode) || isRetryableVaultTxFailure(wallet.lastFailureCode, wallet.lastFailureMessage);
}

function isRetryableFiberFailure(wallet: RecipientWalletDto): boolean {
  return !!wallet.lastFailureCode && (RETRYABLE_FIBER_FAILURE_CODES as readonly string[]).includes(wallet.lastFailureCode);
}

function isRetryablePayoutFailure(wallet: RecipientWalletDto): boolean {
  return isRetryableVaultFailure(wallet) || isRetryableFiberFailure(wallet);
}

function isRetryBackoffElapsed(wallet: RecipientWalletDto, nowMs = Date.now()): boolean {
  if (!wallet.lastAttemptAt) return true;
  const lastAttemptMs = new Date(wallet.lastAttemptAt).getTime();
  return Number.isFinite(lastAttemptMs) && lastAttemptMs <= nowMs - PAYOUT_RETRY_BACKOFF_MS;
}

function isStaleProcessingPayout(wallet: RecipientWalletDto, nowMs = Date.now()): boolean {
  if (wallet.status !== "processing" || !wallet.lastAttemptAt) return false;
  const lastAttemptMs = new Date(wallet.lastAttemptAt).getTime();
  return Number.isFinite(lastAttemptMs) && lastAttemptMs <= nowMs - PAYOUT_PROCESSING_STALE_MS;
}

function isPayoutRecipientProcessable(wallet: RecipientWalletDto): boolean {
  if (!wallet.fiberInvoice && !wallet.address) return false;
  return !wallet.status || wallet.status === 'pending' || (wallet.status === 'failed' && isRetryablePayoutFailure(wallet) && isRetryBackoffElapsed(wallet)) || isStaleProcessingPayout(wallet);
}

async function claimRecipientWalletForPayout(input: { sessionId: string; index: number; staleBefore: Date; retryBefore: Date }): Promise<boolean> {
  const statusPath = "recipientWallets." + input.index + ".status";
  const failureCodePath = "recipientWallets." + input.index + ".lastFailureCode";
  const failureMessagePath = "recipientWallets." + input.index + ".lastFailureMessage";
  const lastAttemptPath = "recipientWallets." + input.index + ".lastAttemptAt";
  const result = await SessionModel.updateOne(
    {
      publicId: input.sessionId,
      $or: [
        { [statusPath]: "pending" },
        { [statusPath]: { $exists: false } },
        { [statusPath]: 'failed', [failureCodePath]: { $in: RETRYABLE_VAULT_CONFIG_FAILURE_CODES }, $or: [{ [lastAttemptPath]: { $lte: input.retryBefore } }, { [lastAttemptPath]: { $exists: false } }] },
        { [statusPath]: 'failed', [failureCodePath]: { $in: RETRYABLE_FIBER_FAILURE_CODES }, $or: [{ [lastAttemptPath]: { $lte: input.retryBefore } }, { [lastAttemptPath]: { $exists: false } }] },
        { [statusPath]: 'failed', [failureCodePath]: 'VAULT_PAYOUT_TX_FAILED', [failureMessagePath]: { $regex: RETRYABLE_VAULT_TX_FAILURE_PATTERN }, $or: [{ [lastAttemptPath]: { $lte: input.retryBefore } }, { [lastAttemptPath]: { $exists: false } }] },
        { [statusPath]: "processing", [lastAttemptPath]: { $lte: input.staleBefore } }
      ]
    },
    {
      $set: {
        [statusPath]: "processing",
        ["recipientWallets." + input.index + ".lastAttemptAt"]: new Date()
      },
      $unset: {
        ["recipientWallets." + input.index + ".lastFailureCode"]: 1,
        ["recipientWallets." + input.index + ".lastFailureMessage"]: 1
      }
    }
  );
  return result.modifiedCount === 1;
}

async function markRecipientWalletFailure(input: {
  sessionId: string;
  index: number;
  failure: { code: string; message: string };
  chargeAttemptId?: string;
}): Promise<void> {
  const pendingRetry = (PENDING_PAYOUT_FAILURE_CODES as readonly string[]).includes(input.failure.code);
  const setFields: Record<string, unknown> = {
    ['recipientWallets.' + input.index + '.status']: pendingRetry ? 'processing' : 'failed',
    ['recipientWallets.' + input.index + '.lastAttemptAt']: new Date(),
    ['recipientWallets.' + input.index + '.lastFailureCode']: input.failure.code,
    ['recipientWallets.' + input.index + '.lastFailureMessage']: input.failure.message
  };
  if (input.chargeAttemptId) {
    setFields['recipientWallets.' + input.index + '.chargeAttemptId'] = input.chargeAttemptId;
  }

  await SessionModel.updateOne(
    { publicId: input.sessionId },
    { $set: setFields }
  );
}

async function markRecipientWalletPaid(input: {
  sessionId: string;
  index: number;
  chargeAttempt?: ChargeAttemptLike | null;
  finalPayoutProofId?: string;
  finalPayoutExplorerUrl?: string;
  fiberPaymentProofId?: string;
}): Promise<void> {
  const proofId = input.finalPayoutProofId ?? input.chargeAttempt?.proofId;
  const isCkbTransaction = Boolean(input.finalPayoutProofId) || input.chargeAttempt?.proofType === 'ckb_transaction' || input.chargeAttempt?.executionLayer === 'ckb-vault';
  const setFields: Record<string, unknown> = {
    ['recipientWallets.' + input.index + '.status']: 'paid',
    ['recipientWallets.' + input.index + '.paidAt']: new Date(),
    ['recipientWallets.' + input.index + '.lastAttemptAt']: new Date(),
    ['recipientWallets.' + input.index + '.chargeAttemptId']: input.chargeAttempt?.attemptId,
    ['recipientWallets.' + input.index + '.payoutProofId']: proofId,
    ...(input.fiberPaymentProofId ? { ['recipientWallets.' + input.index + '.fiberExitPaymentProofId']: input.fiberPaymentProofId } : {})
  };
  const unsetFields: Record<string, 1> = {
    ['recipientWallets.' + input.index + '.lastFailureCode']: 1,
    ['recipientWallets.' + input.index + '.lastFailureMessage']: 1
  };
  if (input.finalPayoutExplorerUrl) {
    setFields['recipientWallets.' + input.index + '.payoutExplorerUrl'] = input.finalPayoutExplorerUrl;
  } else if (proofId && isCkbTransaction) {
    setFields['recipientWallets.' + input.index + '.payoutExplorerUrl'] = ckbTransactionExplorerUrl(proofId, input.chargeAttempt?.network ?? env.FIBER_NETWORK);
  } else {
    unsetFields['recipientWallets.' + input.index + '.payoutExplorerUrl'] = 1;
  }

  await SessionModel.updateOne(
    { publicId: input.sessionId },
    { $set: setFields, $unset: unsetFields }
  );
}

async function latestScheduledPayoutAttempt(sessionId: string, recipientIndex: number): Promise<ChargeAttemptLike | null> {
  return ChargeAttemptModel.findOne({
    sessionId,
    'metadata.scheduledPayout': true,
    'metadata.recipientIndex': recipientIndex
  }).sort({ createdAt: -1 }).lean<ChargeAttemptLike | null>();
}

async function succeededScheduledPayoutSummary(sessionId: string, recipientIndex: number): Promise<{ totalMinor: number; count: number }> {
  const attempts = await ChargeAttemptModel.find({
    sessionId,
    status: 'succeeded',
    'metadata.scheduledPayout': true,
    'metadata.recipientIndex': recipientIndex
  }).select('amountMinor amount currency').lean<ChargeAttemptLike[]>();
  return {
    totalMinor: attempts.reduce((total, attempt) => total + fallbackMinorUnits(attempt.amountMinor, attempt.amount, attempt.currency), 0),
    count: attempts.length
  };
}

async function setRecipientWalletFields(sessionId: string, recipientIndex: number, fields: Record<string, unknown>): Promise<void> {
  const setFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    setFields['recipientWallets.' + recipientIndex + '.' + key] = value;
  }
  if (Object.keys(setFields).length === 0) return;
  await SessionModel.updateOne({ publicId: sessionId }, { $set: setFields });
}

function payoutCycleKey(nextReleaseAt?: Date | string | null): string {
  if (!nextReleaseAt) return 'once';
  const parsed = nextReleaseAt instanceof Date ? nextReleaseAt : new Date(nextReleaseAt);
  return Number.isNaN(parsed.getTime()) ? 'once' : parsed.toISOString();
}

function scheduledPayoutIdempotencyKey(sessionId: string, recipientIndex: number, nextReleaseAt?: Date | string | null): string {
  return 'scheduled:' + sessionId + ':' + recipientIndex + ':' + payoutCycleKey(nextReleaseAt);
}

function fiberExitChargeIdempotencyKey(sessionId: string, recipientIndex: number, nextReleaseAt?: Date | string | null): string {
  return 'fiber-exit:' + sessionId + ':' + recipientIndex + ':' + payoutCycleKey(nextReleaseAt);
}

function fiberExitChargeChunkIdempotencyKey(sessionId: string, recipientIndex: number, chunkIndex: number, nextReleaseAt?: Date | string | null): string {
  return fiberExitChargeIdempotencyKey(sessionId, recipientIndex, nextReleaseAt) + ':chunk:' + chunkIndex;
}

async function ensureFiberExitInvoiceForWallet(input: {
  session: SessionRecord;
  wallet: RecipientWalletDto;
  index: number;
  amountMinor: number;
}): Promise<string> {
  if (input.wallet.fiberExitInvoice) return input.wallet.fiberExitInvoice;
  const recipientAddress = cleanOptionalString(input.wallet.address);
  if (!recipientAddress) {
    throw new ApiError(400, 'RECIPIENT_ADDRESS_REQUIRED', 'Fiber exit payouts require a recipient CKB wallet address.');
  }

  const created = await createFiberExitInvoice({
    amountMinor: input.amountMinor,
    currency: input.session.currency,
    recipientAddress,
    description: 'FiberPass exit payout: ' + input.session.name + ' / ' + input.wallet.name
  });
  await setRecipientWalletFields(input.session.publicId, input.index, {
    fiberExitInvoice: created.invoice,
    fiberExitInvoiceHash: created.invoiceHash
  });
  await writeAuditLog({
    actorWalletId: input.session.ownerWalletId as string,
    action: 'fiber.exit_invoice_created',
    targetType: 'session',
    targetId: input.session.publicId,
    metadata: { recipientIndex: input.index, recipientAddress, invoiceHash: created.invoiceHash, amountMinor: input.amountMinor }
  });
  return created.invoice;
}

async function executeFiberExitPayout(input: {
  session: SessionRecord;
  wallet: RecipientWalletDto;
  index: number;
  amountMinor: number;
}): Promise<{ chargeAttempt: ChargeAttemptLike | null; settlementTxHash: string; settlementExplorerUrl: string; fiberPaymentProofId?: string }> {
  const recipientAddress = cleanOptionalString(input.wallet.address);
  if (!recipientAddress) {
    throw new ApiError(400, 'RECIPIENT_ADDRESS_REQUIRED', 'Fiber exit payouts require a recipient CKB wallet address.');
  }

  const keysendTargetPubkey = env.FIBER_EXIT_KEYSEND_TARGET_PUBKEY.trim();
  const invoice = keysendTargetPubkey ? undefined : await ensureFiberExitInvoiceForWallet(input);
  let chargeAttempt = await latestScheduledPayoutAttempt(input.session.publicId, input.index);
  let fiberPaymentProofId = input.wallet.fiberExitPaymentProofId ?? chargeAttempt?.proofId;

  const succeededFiber = await succeededScheduledPayoutSummary(input.session.publicId, input.index);
  let remainingFiberMinor = Math.max(input.amountMinor - succeededFiber.totalMinor, 0);

  if (remainingFiberMinor > 0) {
    let chunkIndex = succeededFiber.count;
    while (remainingFiberMinor > 0) {
      const chunkMinor = keysendTargetPubkey
        ? Math.min(remainingFiberMinor, (await getCurrentFiberPayoutLiquiditySnapshot()).maxOutboundCapacityMinor ?? 0)
        : remainingFiberMinor;
      if (chunkMinor <= 0) {
        throw new ApiError(409, 'FIBER_CHANNEL_OPEN_PENDING', 'Fiber liquidity is still activating for this payout. The payout worker will retry automatically.');
      }

      await chargeSession({
        sessionId: input.session.publicId,
        amount: fromMinorUnits(chunkMinor, input.session.currency),
        type: 'Scheduled payout via Fiber exit: ' + input.wallet.name,
        appId: undefined,
        appServiceAddress: input.session.serviceAddress,
        paymentRequest: invoice,
        deferSingleUseSettlement: true,
        idempotencyKey: keysendTargetPubkey
          ? fiberExitChargeChunkIdempotencyKey(input.session.publicId, input.index, chunkIndex, input.session.nextReleaseAt)
          : fiberExitChargeIdempotencyKey(input.session.publicId, input.index, input.session.nextReleaseAt),
        metadata: {
          scheduledPayout: true,
          directVaultPayout: false,
          payoutRail: 'fiber_exit',
          recipientIndex: input.index,
          recipientName: input.wallet.name,
          recipientAddress,
          ...(invoice ? { fiberInvoice: invoice, fiberExitInvoice: invoice, fiberAllowSelfPayment: true } : {}),
          ...(keysendTargetPubkey ? { fiberKeysendTargetPubkey: keysendTargetPubkey, fiberPaymentChunkIndex: chunkIndex, fiberPaymentTotalAmountMinor: input.amountMinor } : {}),
          fiberPaymentTimeoutSeconds: 45,
          paymentReference: input.session.paymentReference,
          paymentPurpose: input.session.paymentPurpose
        }
      });
      chargeAttempt = await latestScheduledPayoutAttempt(input.session.publicId, input.index);
      fiberPaymentProofId = chargeAttempt?.proofId;
      remainingFiberMinor -= chunkMinor;
      chunkIndex += 1;
    }

    await setRecipientWalletFields(input.session.publicId, input.index, {
      fiberExitPaymentProofId: fiberPaymentProofId,
      fiberExitPaymentAttemptId: chargeAttempt?.attemptId
    });
  }

  if (!fiberPaymentProofId) {
    throw new ApiError(502, 'FIBER_EXIT_PAYMENT_PROOF_MISSING', 'Fiber exit payment succeeded without a payment proof id.');
  }

  if (input.wallet.fiberExitSettlementTxHash) {
    return {
      chargeAttempt,
      settlementTxHash: input.wallet.fiberExitSettlementTxHash,
      settlementExplorerUrl: input.wallet.fiberExitSettlementExplorerUrl ?? ckbTransactionExplorerUrl(input.wallet.fiberExitSettlementTxHash, env.FIBER_NETWORK) ?? '',
      fiberPaymentProofId
    };
  }

  const settlement = await executeFiberExitCkbSettlement({
    recipientAddress,
    amountMinor: input.amountMinor,
    currency: input.session.currency
  });
  const explorerUrl = ckbTransactionExplorerUrl(settlement.proofId, settlement.network) ?? '';
  await setRecipientWalletFields(input.session.publicId, input.index, {
    fiberExitSettlementTxHash: settlement.proofId,
    fiberExitSettlementStatus: 'submitted',
    fiberExitSettlementExplorerUrl: explorerUrl,
    fiberExitSettledAt: new Date()
  });
  await writeAuditLog({
    actorWalletId: input.session.ownerWalletId as string,
    action: 'fiber.exit_ckb_settlement_submitted',
    targetType: 'session',
    targetId: input.session.publicId,
    metadata: { recipientIndex: input.index, recipientAddress, amountMinor: input.amountMinor, fiberPaymentProofId, txHash: settlement.proofId }
  });

  return { chargeAttempt, settlementTxHash: settlement.proofId, settlementExplorerUrl: explorerUrl, fiberPaymentProofId };
}

async function markRecipientPayoutNotification(input: {
  sessionId: string;
  index: number;
  status: 'sent' | 'failed';
  failure?: string;
}): Promise<void> {
  const setFields: Record<string, unknown> = {
    ['recipientWallets.' + input.index + '.payoutNotificationStatus']: input.status
  };
  const unsetFields: Record<string, 1> = {};
  if (input.status === 'sent') {
    setFields['recipientWallets.' + input.index + '.payoutNotifiedAt'] = new Date();
    unsetFields['recipientWallets.' + input.index + '.payoutNotificationFailure'] = 1;
  } else {
    setFields['recipientWallets.' + input.index + '.payoutNotificationFailure'] = input.failure ?? 'Payout receipt email failed.';
  }
  await SessionModel.updateOne({ publicId: input.sessionId }, { $set: setFields, ...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}) });
}

async function sendPayoutReceiptIfNeeded(input: {
  session: SessionRecord;
  wallet: RecipientWalletDto;
  index: number;
  attempt: ChargeAttemptLike | null;
}): Promise<boolean> {
  if (!input.wallet.email || !input.attempt?.proofId) return false;
  try {
    await sendRecipientPayoutReceiptEmail({
      to: input.wallet.email,
      recipientName: input.wallet.name,
      payerName: input.session.name,
      passName: input.session.name,
      amountMinor: dueWalletAmountMinor(input.wallet, input.session.currency),
      currency: input.session.currency,
      txHash: input.attempt.proofId,
      explorerUrl: input.attempt.proofType === 'ckb_transaction' ? ckbTransactionExplorerUrl(input.attempt.proofId, input.attempt.network ?? env.FIBER_NETWORK) : undefined,
      paidAt: input.wallet.paidAt instanceof Date ? input.wallet.paidAt : new Date(),
      reference: input.session.paymentReference ?? undefined,
      timeZone: input.wallet.recipientTimeZone
    });
    await markRecipientPayoutNotification({ sessionId: input.session.publicId, index: input.index, status: 'sent' });
    return true;
  } catch (error) {
    await markRecipientPayoutNotification({
      sessionId: input.session.publicId,
      index: input.index,
      status: 'failed',
      failure: error instanceof Error ? error.message : 'Payout receipt email failed.'
    });
    return false;
  }
}

export async function runPayoutReceiptNotifications(input: { limit?: number } = {}): Promise<PayoutReceiptNotificationWorkerResult> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const sessions = await SessionModel.find({
    recipientWallets: {
      $elemMatch: {
        status: 'paid',
        email: { $exists: true, $ne: '' },
        payoutProofId: { $exists: true, $ne: '' },
        payoutNotificationStatus: { $in: ['pending', 'failed'] }
      }
    }
  }).sort({ updatedAt: 1 }).limit(limit).lean<SessionRecord[]>();

  const result: PayoutReceiptNotificationWorkerResult = {
    scanned: sessions.length,
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0
  };

  for (const session of sessions) {
    const wallets = (session.recipientWallets ?? []) as RecipientWalletDto[];
    for (const [index, wallet] of wallets.entries()) {
      if (wallet.status !== 'paid' || !wallet.email || !wallet.payoutProofId || !['pending', 'failed'].includes(wallet.payoutNotificationStatus ?? '')) {
        result.skipped += 1;
        continue;
      }

      result.processed += 1;
      const sent = await sendPayoutReceiptIfNeeded({
        session,
        wallet,
        index,
        attempt: {
          attemptId: wallet.chargeAttemptId ?? 'receipt-retry:' + session.publicId + ':' + index,
          sessionId: session.publicId,
          ownerWalletId: session.ownerWalletId as string,
          amount: fromMinorUnits(dueWalletAmountMinor(wallet, session.currency), session.currency),
          amountMinor: dueWalletAmountMinor(wallet, session.currency),
          currency: session.currency,
          type: 'Payout receipt retry: ' + wallet.name,
          status: 'succeeded',
          proofId: wallet.payoutProofId,
          proofType: wallet.payoutExplorerUrl ? 'ckb_transaction' : 'fiber_payment',
          network: env.FIBER_NETWORK
        } as ChargeAttemptLike
      });
      if (sent) result.sent += 1;
      else result.failed += 1;
    }
  }

  return result;
}

interface ScheduledLiquidityPreparationWorkerInput {
  limit?: number;
  ownerWalletId?: string;
  sessionId?: string;
}

export interface ScheduledLiquidityPreparationWorkerResult {
  scanned: number;
  processed: number;
  ready: number;
  pending: number;
  failed: number;
  skipped: number;
}

function hasPendingLiquidityFailure(wallet: RecipientWalletDto): boolean {
  return PENDING_PAYOUT_FAILURE_CODES.includes(wallet.lastFailureCode as typeof PENDING_PAYOUT_FAILURE_CODES[number]);
}

function isLiquidityRecipientPreparable(wallet: RecipientWalletDto): boolean {
  if (!wallet.address && !wallet.fiberInvoice) return false;
  if (wallet.status === 'paid' || wallet.status === 'awaiting_details') return false;
  if (wallet.status === 'processing') return isStaleProcessingPayout(wallet);
  if (wallet.status === 'failed') return isRetryablePayoutFailure(wallet) && isRetryBackoffElapsed(wallet);
  if (hasPendingLiquidityFailure(wallet) && !isRetryBackoffElapsed(wallet)) return false;
  return !wallet.status || wallet.status === 'pending';
}

async function clearRecipientWalletFailure(sessionId: string, recipientIndex: number): Promise<void> {
  await SessionModel.updateOne(
    { publicId: sessionId },
    {
      $unset: {
        ['recipientWallets.' + recipientIndex + '.lastFailureCode']: 1,
        ['recipientWallets.' + recipientIndex + '.lastFailureMessage']: 1
      }
    }
  );
}

async function markRecipientWalletLiquidityPreparationFailure(input: {
  sessionId: string;
  index: number;
  failure: { code: string; message: string };
}): Promise<void> {
  const pendingRetry = (PENDING_PAYOUT_FAILURE_CODES as readonly string[]).includes(input.failure.code);
  const setFields: Record<string, unknown> = {
    ['recipientWallets.' + input.index + '.status']: pendingRetry ? 'pending' : 'failed',
    ['recipientWallets.' + input.index + '.lastAttemptAt']: new Date(),
    ['recipientWallets.' + input.index + '.lastFailureCode']: input.failure.code,
    ['recipientWallets.' + input.index + '.lastFailureMessage']: input.failure.message
  };

  await SessionModel.updateOne(
    { publicId: input.sessionId },
    { $set: setFields }
  );
}

export async function runScheduledLiquidityPreparation(input: ScheduledLiquidityPreparationWorkerInput = {}): Promise<ScheduledLiquidityPreparationWorkerResult> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const now = new Date();
  const recipientDestinationFilters: Record<string, unknown>[] = [
    { address: { $exists: true, $ne: '' } },
    { fiberInvoice: { $exists: true, $ne: '' } }
  ];
  const sessionQuery: Record<string, unknown> = {
    status: 'active',
    paymentPurpose: { $in: ['subscription', 'scheduled_release', 'recurring_release'] },
    nextReleaseAt: { $exists: true, $ne: null },
    $or: [{ expiryAt: { $gt: now } }, { expiryAt: { $exists: false } }, { expiryAt: null }],
    recipientWallets: {
      $elemMatch: {
        $or: recipientDestinationFilters
      }
    }
  };
  if (input.ownerWalletId) sessionQuery.ownerWalletId = input.ownerWalletId;
  if (input.sessionId) sessionQuery.publicId = input.sessionId;

  const sessions = await SessionModel.find(sessionQuery).sort({ nextReleaseAt: 1, createdAt: 1 }).limit(limit);
  const result: ScheduledLiquidityPreparationWorkerResult = {
    scanned: sessions.length,
    processed: 0,
    ready: 0,
    pending: 0,
    failed: 0,
    skipped: 0
  };

  for (const session of sessions) {
    const wallets = [...((session.recipientWallets ?? []) as RecipientWalletDto[])];
    if (wallets.length === 0) {
      result.skipped += 1;
      continue;
    }

    let sessionTouched = false;
    for (const [index, wallet] of wallets.entries()) {
      if (earlierRecipientHasInFlightLiquidity(wallets, index)) {
        result.skipped += 1;
        continue;
      }
      if (!isLiquidityRecipientPreparable(wallet)) {
        result.skipped += 1;
        continue;
      }

      const amountMinor = dueWalletAmountMinor(wallet, session.currency);
      if (amountMinor <= 0) {
        await markRecipientWalletLiquidityPreparationFailure({
          sessionId: session.publicId,
          index,
          failure: {
            code: 'RECIPIENT_AMOUNT_REQUIRED',
            message: 'Scheduled payout recipient is missing an amount.'
          }
        });
        result.processed += 1;
        result.failed += 1;
        sessionTouched = true;
        continue;
      }

      try {
        await ensureVaultFundedFiberLiquidity({
          ownerWalletId: session.ownerWalletId as string,
          sessionId: session.publicId,
          recipientIndex: index,
          amountMinor,
          currency: session.currency
        });
        await clearRecipientWalletFailure(session.publicId, index);
        result.processed += 1;
        result.ready += 1;
        sessionTouched = true;
      } catch (error) {
        const failure = failureFromError(error);
        await markRecipientWalletLiquidityPreparationFailure({ sessionId: session.publicId, index, failure });
        result.processed += 1;
        sessionTouched = true;
        if (PENDING_PAYOUT_FAILURE_CODES.includes(failure.code as typeof PENDING_PAYOUT_FAILURE_CODES[number])) {
          result.pending += 1;
          break;
        }
        result.failed += 1;
      }
    }

    if (sessionTouched) {
      await publishOverview(session.ownerWalletId as string).catch(() => undefined);
    }
  }

  return result;
}

async function finalizePayoutCycleIfComplete(sessionId: string, walletId: string): Promise<void> {
  const session = await SessionModel.findOne({ publicId: sessionId });
  if (!session || session.status !== 'active') return;
  const wallets = (session.recipientWallets ?? []) as RecipientWalletDto[];
  if (wallets.length === 0 || wallets.some((wallet) => wallet.status !== 'paid')) return;

  if (session.paymentPurpose === 'subscription' || session.paymentPurpose === 'recurring_release') {
    const nextReleaseAt = advanceReleaseDate(
      session.nextReleaseAt instanceof Date ? session.nextReleaseAt : undefined,
      session.releaseCadence as ReleaseCadence | undefined
    );
    const expiryAt = session.expiryAt instanceof Date ? session.expiryAt : undefined;
    if (nextReleaseAt && (!expiryAt || nextReleaseAt.getTime() < expiryAt.getTime())) {
      session.nextReleaseAt = nextReleaseAt;
      session.set('recipientWallets', wallets.map((wallet) => ({
        name: wallet.name,
        address: wallet.address,
        amount: wallet.amount,
        amountMinor: wallet.amountMinor,
        fiberInvoice: wallet.fiberInvoice,
        email: wallet.email,
        fiberLiquidityBridgeTxHash: undefined,
        fiberLiquidityBridgeAmountMinor: undefined,
        fiberLiquidityBridgeStatus: undefined,
        fiberLiquidityBridgeCreatedAt: undefined,
        fiberLiquidityBridgeTopUpTxHash: undefined,
        fiberLiquidityBridgeTopUpAmountMinor: undefined,
        fiberLiquidityBridgeTopUpStatus: undefined,
        fiberLiquidityBridgeTopUpCreatedAt: undefined,
        fiberChannelOpenProofId: undefined,
        fiberChannelOpenAmountMinor: undefined,
        fiberChannelOpenRequestedAt: undefined,
        fiberExitInvoice: undefined,
        fiberExitInvoiceHash: undefined,
        fiberExitPaymentProofId: undefined,
        fiberExitPaymentAttemptId: undefined,
        fiberExitSettlementTxHash: undefined,
        fiberExitSettlementStatus: undefined,
        fiberExitSettlementExplorerUrl: undefined,
        fiberExitSettledAt: undefined,
        status: wallet.address || wallet.fiberInvoice ? 'pending' : 'awaiting_details',
        inviteStatus: wallet.address || wallet.fiberInvoice ? 'claimed' : wallet.inviteStatus
      })));
      prependLogs(session, newLog('Recurring Payout Cycle Completed'));
      await session.save();
      await writeAuditLog({ actorWalletId: walletId, action: 'session.recurring_cycle_completed', targetType: 'session', targetId: sessionId, metadata: { nextReleaseAt } });
      return;
    }
  }

  await settleSession(sessionId, walletId).catch(() => undefined);
}

export async function runDueSessionPayouts(input: DueSessionPayoutWorkerInput = {}): Promise<DueSessionPayoutWorkerResult> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const staleBefore = new Date(Date.now() - PAYOUT_PROCESSING_STALE_MS);
  const retryBefore = new Date(Date.now() - PAYOUT_RETRY_BACKOFF_MS);
  const recipientStatusFilters: Record<string, unknown>[] = [
    { status: "pending" },
    { status: { $exists: false } }
  ];
  recipientStatusFilters.push(
    { status: 'failed', lastFailureCode: { $in: [...RETRYABLE_VAULT_CONFIG_FAILURE_CODES, ...RETRYABLE_FIBER_FAILURE_CODES] }, $or: [{ lastAttemptAt: { $lte: retryBefore } }, { lastAttemptAt: { $exists: false } }] },
    { status: 'failed', lastFailureCode: 'VAULT_PAYOUT_TX_FAILED', lastFailureMessage: { $regex: RETRYABLE_VAULT_TX_FAILURE_PATTERN }, $or: [{ lastAttemptAt: { $lte: retryBefore } }, { lastAttemptAt: { $exists: false } }] },
    { status: "processing", lastAttemptAt: { $lte: staleBefore } }
  );

  const sessionQuery: Record<string, unknown> = {
    status: "active",
    paymentPurpose: { $in: ["subscription", "scheduled_release", "recurring_release"] },
    nextReleaseAt: { $lte: new Date() },
    recipientWallets: {
      $elemMatch: {
        $or: recipientStatusFilters
      }
    }
  };
  if (input.ownerWalletId) sessionQuery.ownerWalletId = input.ownerWalletId;

  const dueSessions = await SessionModel.find(sessionQuery).sort({ nextReleaseAt: 1, createdAt: 1 }).limit(limit);

  const result: DueSessionPayoutWorkerResult = {
    scanned: dueSessions.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0
  };


  for (const session of dueSessions) {
    const sessionObject = session.toObject() as SessionRecord;
    const wallets = [...(sessionObject.recipientWallets ?? [])] as RecipientWalletDto[];
    if (wallets.length === 0) {
      result.skipped += 1;
      continue;
    }

    for (const [index, wallet] of wallets.entries()) {
      if (earlierRecipientHasInFlightLiquidity(wallets, index)) {
        result.skipped += 1;
        continue;
      }
      if (!isPayoutRecipientProcessable(wallet)) continue;
      const claimed = await claimRecipientWalletForPayout({ sessionId: session.publicId, index, staleBefore, retryBefore });
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      result.processed += 1;
      const amountMinor = dueWalletAmountMinor(wallet, session.currency);
      if (amountMinor <= 0) {
        const failure = {
          code: "RECIPIENT_AMOUNT_REQUIRED",
          message: "Scheduled payout recipient is missing an amount."
        };
        await markRecipientWalletFailure({ sessionId: session.publicId, index, failure });
        result.failed += 1;
        continue;
      }

      const recipientAddress = cleanOptionalString(wallet.address);
      const fiberInvoice = wallet.fiberInvoice;
      if (!recipientAddress && !fiberInvoice) {
        await markRecipientWalletFailure({
          sessionId: session.publicId,
          index,
          failure: {
            code: 'RECIPIENT_DESTINATION_REQUIRED',
            message: 'Scheduled payout recipient needs a CKB wallet address or Fiber invoice/payment request.'
          }
        });
        result.failed += 1;
        continue;
      }

      try {
        await ensureVaultFundedFiberLiquidity({
          ownerWalletId: session.ownerWalletId as string,
          sessionId: session.publicId,
          recipientIndex: index,
          amountMinor,
          currency: session.currency
        });

        if (recipientAddress && !fiberInvoice) {
          const exitResult = await executeFiberExitPayout({ session: sessionObject, wallet, index, amountMinor });
          await markRecipientWalletPaid({
            sessionId: session.publicId,
            index,
            chargeAttempt: exitResult.chargeAttempt,
            finalPayoutProofId: exitResult.settlementTxHash,
            finalPayoutExplorerUrl: exitResult.settlementExplorerUrl,
            fiberPaymentProofId: exitResult.fiberPaymentProofId
          });
          const receiptAttempt = {
            ...(exitResult.chargeAttempt ?? {}),
            proofId: exitResult.settlementTxHash,
            proofType: 'ckb_transaction',
            executionLayer: 'fiber',
            network: env.FIBER_NETWORK
          } as ChargeAttemptLike;
          await sendPayoutReceiptIfNeeded({ session: sessionObject, wallet, index, attempt: receiptAttempt });
        } else {
          await chargeSession({
            sessionId: session.publicId,
            amount: fromMinorUnits(amountMinor, session.currency),
            type: "Scheduled payout: " + wallet.name,
            appId: session.appId ?? undefined,
            appServiceAddress: session.serviceAddress,
            paymentRequest: fiberInvoice,
            idempotencyKey: scheduledPayoutIdempotencyKey(session.publicId, index, session.nextReleaseAt),
            metadata: {
              scheduledPayout: true,
              directVaultPayout: false,
              payoutRail: "fiber",
              recipientIndex: index,
              recipientName: wallet.name,
              recipientAddress,
              fiberInvoice,
              paymentReference: session.paymentReference,
              paymentPurpose: session.paymentPurpose
            }
          });
          const chargeAttempt = await latestScheduledPayoutAttempt(session.publicId, index);
          await markRecipientWalletPaid({ sessionId: session.publicId, index, chargeAttempt });
          await sendPayoutReceiptIfNeeded({ session: sessionObject, wallet, index, attempt: chargeAttempt });
        }
        result.succeeded += 1;
      } catch (error) {
        const chargeAttempt = await latestScheduledPayoutAttempt(session.publicId, index);
        const failure = failureFromError(error);
        await markRecipientWalletFailure({ sessionId: session.publicId, index, failure, chargeAttemptId: chargeAttempt?.attemptId });
        result.failed += 1;
        if (PENDING_PAYOUT_FAILURE_CODES.includes(failure.code as typeof PENDING_PAYOUT_FAILURE_CODES[number])) break;
      }
    }

    await finalizePayoutCycleIfComplete(session.publicId, session.ownerWalletId as string);
    await publishOverview(session.ownerWalletId as string).catch(() => undefined);
  }

  return result;
}

export function isValidIconType(iconType: string): iconType is IconType {
  return (ICON_TYPES as readonly string[]).includes(iconType);
}

export function isValidPaymentPurpose(value: string): value is PaymentPurpose {
  return (PAYMENT_PURPOSES as readonly string[]).includes(value);
}

export function isValidReleaseCadence(value: string): value is ReleaseCadence {
  return (RELEASE_CADENCES as readonly string[]).includes(value);
}
