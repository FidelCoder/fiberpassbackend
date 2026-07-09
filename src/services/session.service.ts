import { randomUUID } from 'node:crypto';
import { ApiError } from '../lib/errors.js';
import { liveEvents } from '../lib/liveEvents.js';
import { clampMinorUnits, fallbackMinorUnits, fromMinorUnits, roundMoney, toMinorUnits } from '../lib/money.js';
import { ChargeAttemptModel, type ChargeAttemptRecord } from '../models/chargeAttempt.model.js';
import { ICON_TYPES, SessionModel, type IconType, type SessionRecord, type SessionStatus } from '../models/session.model.js';
import { WalletFundingModel } from '../models/walletFunding.model.js';
import { WalletModel, type WalletRecord } from '../models/wallet.model.js';
import { writeAuditLog } from './audit.service.js';
import { fiberProvider } from './fiberProvider.js';

const LEGACY_PLACEHOLDER_BALANCE_MINOR = toMinorUnits('1240.50', 'USDC');
const HISTORY_STATUSES: SessionStatus[] = ['settled', 'revoked', 'expired'];
const OPEN_STATUSES: SessionStatus[] = ['active', 'paused'];

export const CREATE_SESSION_POLICY = {
  minLimit: 0.01,
  maxLimit: 100000,
  currency: 'CKB',
  minExpiryMinutes: 5,
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
  proofId?: string;
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
  chargePolicy?: string;
  expiryAt?: Date;
  platformFeeEstimate?: number;
  platformFeeEstimateMinor?: number;
  networkFeeEstimate?: number;
  networkFeeEstimateMinor?: number;
  spent: number;
  spentMinor?: number;
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
  chargePolicy?: string;
  expiryAt?: string;
  platformFeeEstimate?: number;
  platformFeeEstimateMinor?: number;
  networkFeeEstimate?: number;
  networkFeeEstimateMinor?: number;
  spent: number;
  spentMinor: number;
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
  appServiceAddress?: string;
  metadata?: Record<string, unknown>;
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
    proofId: attempt.proofId ?? undefined,
    createdAt: (attempt.createdAt ?? new Date()).toISOString()
  };
}

function toSessionDto(session: SessionLike, chargeAttempts: ChargeAttemptDto[] = []): SessionDto {
  const spentMinor = sessionSpentMinor(session);
  const limitMinor = sessionLimitMinor(session);
  const remainingBalanceMinor = clampMinorUnits(limitMinor - spentMinor);
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
    chargePolicy: session.chargePolicy,
    expiryAt: session.expiryAt instanceof Date ? session.expiryAt.toISOString() : session.expiryAt,
    platformFeeEstimate: fromMinorUnits(platformFeeEstimateMinor, session.currency),
    platformFeeEstimateMinor,
    networkFeeEstimate: fromMinorUnits(networkFeeEstimateMinor, session.currency),
    networkFeeEstimateMinor,
    spent: fromMinorUnits(spentMinor, session.currency),
    spentMinor,
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

export function walletIdFromAddress(address: string): string {
  return address.toLowerCase();
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

  const walletObject = currentWallet.toObject();
  const balanceMinor = walletBalanceMinor(walletObject);
  if (walletObject.balanceMinor !== balanceMinor) {
    currentWallet.balanceMinor = balanceMinor;
    currentWallet.balance = fromMinorUnits(balanceMinor, currentWallet.currency);
    await currentWallet.save();
  }

  return currentWallet.toObject();
}

async function getWalletDocument(walletId: string) {
  await ensureWalletMoneyFields(walletId);
  await resetUntouchedLegacyPlaceholderBalance(walletId);
  const wallet = await WalletModel.findOne({ walletId });
  if (!wallet) {
    throw new ApiError(404, 'WALLET_NOT_FOUND', 'Connect with JoyID before loading FiberPass sessions.');
  }
  return wallet;
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

  const verifiedApp = getVerifiedApp(input.appId);
  if (input.appId && input.appId !== 'manual' && !verifiedApp) {
    throw new ApiError(400, 'APP_NOT_VERIFIED', 'Selected app is not available for FiberPass sessions.');
  }

  await ensureWalletMoneyFields(walletId);

  const expiryAt = validateExpiryAt(input.expiryAt);
  const publicId = newPublicId();
  const serviceAddress = verifiedApp?.serviceAddress ?? input.serviceAddress;
  const appPermissions = verifiedApp?.permissions ?? input.appPermissions ?? [];
  const platformFeeEstimateMinor = estimatePlatformFeeMinor(limitMinor);
  const networkFeeEstimateMinor = toMinorUnits(String(CREATE_SESSION_POLICY.estimatedNetworkFee), input.currency);
  const limit = fromMinorUnits(limitMinor, input.currency);

  const wallet = await WalletModel.findOneAndUpdate(
    { walletId, balanceMinor: { $gte: limitMinor } },
    { $inc: { balanceMinor: -limitMinor, balance: -limit } },
    { new: true }
  );

  if (!wallet) {
    throw new ApiError(400, 'INSUFFICIENT_WALLET_BALANCE', 'Wallet balance is too low for this FiberPass limit.');
  }

  try {
    const fiberSession = await fiberProvider.createSession({
      localSessionId: publicId,
      walletId,
      appAddress: serviceAddress,
      amountMinor: limitMinor,
      currency: input.currency,
      expiresAt: expiryAt,
      metadata: { appId: verifiedApp?.id ?? input.appId }
    });

    await SessionModel.create({
      ownerWalletId: walletId,
      publicId,
      name: verifiedApp?.name ?? input.name,
      serviceAddress,
      appId: verifiedApp?.id ?? input.appId,
      appUrl: verifiedApp?.url ?? input.appUrl,
      appTrustLevel: verifiedApp?.trustLevel ?? input.appTrustLevel,
      appPermissions,
      chargePolicy: verifiedApp?.chargePolicy ?? input.chargePolicy,
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
      fiberProvider: fiberSession.provider,
      fiberNetwork: fiberSession.network,
      fiberSessionId: fiberSession.networkSessionId,
      fiberStatus: fiberSession.status,
      fiberProofId: fiberSession.proofId,
      autoMicroCharges: input.autoMicroCharges,
      singleUse: input.singleUse,
      logs: [newLog('Session Stream Limit Created')]
    });

    await writeAuditLog({ actorWalletId: walletId, action: 'session.created', targetType: 'session', targetId: publicId, metadata: { limitMinor, appId: verifiedApp?.id ?? input.appId } });
  } catch (error) {
    await WalletModel.updateOne({ walletId }, { $inc: { balanceMinor: limitMinor, balance: limit } });
    throw error;
  }

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

  await ensureWalletMoneyFields(walletId);
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
    const result = await fiberProvider.topUpSession({
      sessionId: publicId,
      networkSessionId: session.fiberSessionId ?? undefined,
      walletId,
      amountMinor: topUpMinor,
      currency: session.currency
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
  const result = await fiberProvider.revokeSession({
    sessionId: publicId,
    networkSessionId: session.fiberSessionId ?? undefined,
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
  const result = await fiberProvider.settleSession({
    sessionId: publicId,
    networkSessionId: session.fiberSessionId ?? undefined,
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

function failureFromError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'CHARGE_FAILED', message: error.message };
  }
  return { code: 'CHARGE_FAILED', message: 'Charge attempt failed.' };
}

export async function chargeSession(input: ChargeSessionInput): Promise<SessionsOverviewDto> {
  const amountMinor = toMinorUnits(String(input.amount), CREATE_SESSION_POLICY.currency);
  const attempt = await ChargeAttemptModel.create({
    attemptId: randomUUID(),
    sessionId: input.sessionId,
    appId: input.appId,
    apiKeyId: input.apiKeyId,
    amount: fromMinorUnits(amountMinor, CREATE_SESSION_POLICY.currency),
    amountMinor,
    currency: CREATE_SESSION_POLICY.currency,
    type: input.type,
    status: 'pending',
    metadata: input.metadata
  });

  try {
    if (amountMinor <= 0) {
      throw new ApiError(400, 'INVALID_CHARGE_AMOUNT', 'Charge amount must be greater than zero.');
    }

    const session = await getSessionOrThrow(input.sessionId);
    const ownerWalletId = session.ownerWalletId as string;
    const currency = session.currency;
    const sessionObject = session.toObject();
    const spentMinor = sessionSpentMinor(sessionObject);
    const limitMinor = sessionLimitMinor(sessionObject);
    attempt.ownerWalletId = ownerWalletId;
    attempt.currency = currency;
    attempt.amount = fromMinorUnits(amountMinor, currency);
    attempt.amountMinor = amountMinor;

    if (input.appId) {
      const appIdMatches = session.appId === input.appId;
      const serviceAddressMatches = normalizedAddress(session.serviceAddress) === normalizedAddress(input.appServiceAddress);
      if (!appIdMatches && !serviceAddressMatches) {
        throw new ApiError(403, 'APP_SESSION_MISMATCH', 'This app cannot charge a FiberPass owned by another app.');
      }
    }

    if (session.status !== 'active') {
      throw new ApiError(409, 'SESSION_NOT_CHARGEABLE', 'Session is ' + session.status + '; charges are blocked.');
    }

    const expiryAt = session.expiryAt instanceof Date ? session.expiryAt : undefined;
    if (expiryAt && expiryAt.getTime() <= Date.now()) {
      session.status = 'expired';
      session.fiberStatus = 'expired';
      session.expiryTime = 'Expired';
      prependLogs(session, newLog('Charge Blocked - Session Expired'));
      await session.save();
      await publishOverview(ownerWalletId);
      throw new ApiError(410, 'SESSION_EXPIRED', 'Session has expired; charges are blocked.');
    }

    const remainingMinor = clampMinorUnits(limitMinor - spentMinor);
    if (amountMinor > remainingMinor) {
      const result = await fiberProvider.settleSession({
        sessionId: input.sessionId,
        networkSessionId: session.fiberSessionId ?? undefined,
        amountMinor: 0,
        currency,
        reason: 'expired'
      });
      session.status = 'expired';
      session.fiberProvider = result.provider;
      session.fiberNetwork = result.network;
      session.fiberStatus = 'expired';
      session.fiberProofId = result.proofId;
      session.expiryTime = 'Limit Exhausted';
      prependLogs(session, newLog('Charge Blocked - Spending Limit Exhausted'));
      await session.save();
      await publishOverview(ownerWalletId);
      throw new ApiError(402, 'SESSION_LIMIT_EXCEEDED', 'Charge exceeds the remaining FiberPass balance.');
    }

    const charge = await fiberProvider.authorizeCharge({
      sessionId: input.sessionId,
      networkSessionId: session.fiberSessionId ?? undefined,
      appAddress: session.serviceAddress,
      amountMinor,
      currency,
      paymentRequest: typeof input.metadata?.fiberInvoice === 'string' ? input.metadata.fiberInvoice : undefined,
      metadata: input.metadata
    });

    const nextSpentMinor = spentMinor + amountMinor;
    session.spentMinor = nextSpentMinor;
    session.spent = fromMinorUnits(nextSpentMinor, currency);
    session.lastChargeProofId = charge.proofId;
    session.fiberProvider = charge.provider;
    session.fiberNetwork = charge.network;
    prependLogs(session, newLog(input.type, amountMinor, currency));

    if (nextSpentMinor >= limitMinor) {
      const result = await fiberProvider.settleSession({
        sessionId: input.sessionId,
        networkSessionId: session.fiberSessionId ?? undefined,
        amountMinor: 0,
        currency,
        reason: 'expired'
      });
      session.status = 'expired';
      session.fiberStatus = 'expired';
      session.fiberProofId = result.proofId;
      session.expiryTime = 'Limit Exhausted';
      prependLogs(session, newLog('Spending Limit Exhausted - Settled'));
    } else if (session.singleUse) {
      const refundMinor = clampMinorUnits(limitMinor - nextSpentMinor);
      const refundAmount = fromMinorUnits(refundMinor, currency);
      const result = await fiberProvider.settleSession({
        sessionId: input.sessionId,
        networkSessionId: session.fiberSessionId ?? undefined,
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
    }

    await session.save();

    attempt.status = 'succeeded';
    attempt.provider = charge.provider;
    attempt.network = charge.network;
    attempt.proofId = charge.proofId;
    attempt.resultingSpent = fromMinorUnits(sessionSpentMinor(session.toObject()), currency);
    attempt.resultingSpentMinor = sessionSpentMinor(session.toObject());
    attempt.remainingBalanceMinor = clampMinorUnits(sessionLimitMinor(session.toObject()) - sessionSpentMinor(session.toObject()));
    attempt.remainingBalance = fromMinorUnits(attempt.remainingBalanceMinor, currency);
    await attempt.save();
    await writeAuditLog({ actorWalletId: ownerWalletId, action: 'charge.succeeded', targetType: 'session', targetId: input.sessionId, metadata: { appId: input.appId, amountMinor, proofId: charge.proofId } });

    const overview = await getSessionsOverview(ownerWalletId);
    liveEvents.publish('overview:' + ownerWalletId, overview);
    return overview;
  } catch (error) {
    const failure = failureFromError(error);
    attempt.status = 'failed';
    attempt.failureCode = failure.code;
    attempt.failureMessage = failure.message;
    await attempt.save().catch(() => undefined);
    throw error;
  }
}

export function isValidIconType(iconType: string): iconType is IconType {
  return (ICON_TYPES as readonly string[]).includes(iconType);
}
