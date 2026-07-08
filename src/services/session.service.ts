import { randomUUID } from 'node:crypto';
import { FilterQuery } from 'mongoose';
import { seedSessions } from '../data/seed.js';
import { ApiError } from '../lib/errors.js';
import { liveEvents } from '../lib/liveEvents.js';
import { ChargeAttemptModel, type ChargeAttemptRecord } from '../models/chargeAttempt.model.js';
import { roundMoney, utcTimeLabel } from '../lib/time.js';
import { ICON_TYPES, SessionModel, type IconType, type SessionRecord, type SessionStatus } from '../models/session.model.js';
import { WalletModel, type WalletRecord } from '../models/wallet.model.js';
import { fiberAdapter } from './fiberAdapter.js';

export const DEMO_WALLET_ID = 'demo-wallet';
export const DEMO_WALLET_ADDRESS = '0x71C7656EC7ab88b098defB751B7401B5f6d14766';
const DEFAULT_WALLET_BALANCE = 1240.5;
const HISTORY_STATUSES: SessionStatus[] = ['settled', 'revoked', 'expired'];
const OPEN_STATUSES: SessionStatus[] = ['active', 'paused'];

export const CREATE_SESSION_POLICY = {
  minLimit: 0.05,
  maxLimit: 500,
  currency: 'USDC',
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
  chargePolicy: string;
  iconType: IconType;
  permissions: string[];
}

const VERIFIED_APP_CATALOG: VerifiedAppDto[] = [
  {
    id: 'fiber-ai-demo',
    name: 'Fiber AI Demo',
    serviceAddress: '0xA17a00000000000000000000000000000000F1b3',
    url: 'https://demo.fiberpass.app/ai',
    category: 'AI/API',
    trustLevel: 'verified',
    description: 'Reference AI/API app for per-request Fiber micropayments.',
    defaultCharge: 0.02,
    chargePolicy: '$0.02 per completed request',
    iconType: 'ai',
    permissions: ['Charge approved requests', 'Read pass status', 'Receive revoke events']
  },
  {
    id: 'fiber-rpc-relay',
    name: 'Fiber RPC Relay',
    serviceAddress: '0xA17a00000000000000000000000000000000c0de',
    url: 'https://relay.fiberpass.app',
    category: 'RPC',
    trustLevel: 'reviewed',
    description: 'RPC relay app for small metered node calls.',
    defaultCharge: 0.005,
    chargePolicy: '$0.005 per RPC call',
    iconType: 'rpc',
    permissions: ['Charge API calls', 'Read remaining balance']
  },
  {
    id: 'fiber-storage-demo',
    name: 'Fiber Storage Demo',
    serviceAddress: '0xA17a00000000000000000000000000000000dB01',
    url: 'https://storage.fiberpass.app',
    category: 'Storage',
    trustLevel: 'reviewed',
    description: 'Metered storage demo for bandwidth and object reads.',
    defaultCharge: 0.01,
    chargePolicy: '$0.01 per storage operation',
    iconType: 'database',
    permissions: ['Charge storage operations', 'Read pass status']
  }
];

interface TransactionLogDto {
  id: string;
  type: string;
  timestamp: string;
  amount: number;
}

export interface ChargeAttemptDto {
  id: string;
  sessionId: string;
  appId?: string;
  apiKeyId?: string;
  amount: number;
  currency: string;
  type: string;
  status: string;
  failureCode?: string;
  failureMessage?: string;
  resultingSpent?: number;
  remainingBalance?: number;
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
  networkFeeEstimate?: number;
  spent: number;
  limit: number;
  currency: string;
  duration: string;
  status: SessionStatus;
  iconType: IconType;
  expiryTime: string;
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
  networkFeeEstimate?: number;
  spent: number;
  limit: number;
  currency: string;
  duration: string;
  status: SessionStatus;
  iconType: IconType;
  createdAt: string;
  expiryTime: string;
  autoMicroCharges: boolean;
  singleUse: boolean;
  logs: TransactionLogDto[];
  chargeAttempts: ChargeAttemptDto[];
}

export interface WalletDto {
  connected: boolean;
  address: string;
  balance: number;
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
    max: number;
    currency: string;
  };
  expiry: {
    minMinutes: number;
    maxDays: number;
  };
  fees: {
    platformFeeBps: number;
    minPlatformFee: number;
    estimatedNetworkFee: number;
  };
  verifiedApps: VerifiedAppDto[];
}

export interface WalletIdentity {
  walletId: string;
  address: string;
}

function newPublicId(): string {
  const raw = randomUUID().replace(/-/g, '');
  return `0x${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function newLog(type: string, amount = 0): TransactionLogDto {
  return {
    id: `log-${Date.now()}-${randomUUID().slice(0, 8)}`,
    type,
    timestamp: utcTimeLabel(),
    amount: roundMoney(amount)
  };
}

function prependLogs(
  session: { get: (path: string) => unknown; set: (path: string, value: unknown) => void },
  ...logs: TransactionLogDto[]
): void {
  const existingLogs = (session.get('logs') as TransactionLogDto[] | undefined) ?? [];
  session.set('logs', [...logs, ...existingLogs]);
}

function toChargeAttemptDto(attempt: ChargeAttemptLike): ChargeAttemptDto {
  return {
    id: attempt.attemptId,
    sessionId: attempt.sessionId,
    appId: attempt.appId ?? undefined,
    apiKeyId: attempt.apiKeyId ?? undefined,
    amount: roundMoney(attempt.amount),
    currency: attempt.currency,
    type: attempt.type,
    status: attempt.status,
    failureCode: attempt.failureCode ?? undefined,
    failureMessage: attempt.failureMessage ?? undefined,
    resultingSpent: attempt.resultingSpent == null ? undefined : roundMoney(attempt.resultingSpent),
    remainingBalance: attempt.remainingBalance == null ? undefined : roundMoney(attempt.remainingBalance),
    createdAt: (attempt.createdAt ?? new Date()).toISOString()
  };
}

function toSessionDto(session: SessionLike, chargeAttempts: ChargeAttemptDto[] = []): SessionDto {
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
    platformFeeEstimate: roundMoney(session.platformFeeEstimate ?? 0),
    networkFeeEstimate: roundMoney(session.networkFeeEstimate ?? 0),
    spent: roundMoney(session.spent),
    limit: roundMoney(session.limit),
    currency: session.currency,
    duration: session.duration,
    status: session.status,
    iconType: session.iconType,
    createdAt: (session.createdAt ?? new Date()).toISOString(),
    expiryTime: session.expiryTime,
    autoMicroCharges: session.autoMicroCharges,
    singleUse: session.singleUse,
    logs: session.logs ?? [],
    chargeAttempts
  };
}

function toWalletDto(wallet: WalletRecord): WalletDto {
  return {
    connected: wallet.connected,
    address: wallet.address,
    balance: roundMoney(wallet.balance),
    currency: wallet.currency
  };
}

async function publishOverview(walletId: string): Promise<void> {
  liveEvents.publish(`overview:${walletId}`, await getSessionsOverview(walletId));
}

function seedForWallet(walletId: string, useFixedIds = false): Array<Record<string, unknown>> {
  return seedSessions.map((session) => ({
    ...session,
    ownerWalletId: walletId,
    publicId: useFixedIds ? session.publicId : newPublicId()
  }));
}

export function getCreateSessionPolicy(): CreateSessionPolicyDto {
  return {
    limits: {
      min: CREATE_SESSION_POLICY.minLimit,
      max: CREATE_SESSION_POLICY.maxLimit,
      currency: CREATE_SESSION_POLICY.currency
    },
    expiry: {
      minMinutes: CREATE_SESSION_POLICY.minExpiryMinutes,
      maxDays: CREATE_SESSION_POLICY.maxExpiryDays
    },
    fees: {
      platformFeeBps: CREATE_SESSION_POLICY.platformFeeBps,
      minPlatformFee: CREATE_SESSION_POLICY.minPlatformFee,
      estimatedNetworkFee: CREATE_SESSION_POLICY.estimatedNetworkFee
    },
    verifiedApps: VERIFIED_APP_CATALOG
  };
}

function getVerifiedApp(appId?: string): VerifiedAppDto | undefined {
  if (!appId || appId === 'manual') return undefined;
  return VERIFIED_APP_CATALOG.find((app) => app.id === appId);
}

function validateCreateLimit(limit: number): void {
  if (limit < CREATE_SESSION_POLICY.minLimit || limit > CREATE_SESSION_POLICY.maxLimit) {
    throw new ApiError(
      400,
      'SESSION_LIMIT_OUT_OF_RANGE',
      'FiberPass limit must be between $' + CREATE_SESSION_POLICY.minLimit.toFixed(2) + ' and $' + CREATE_SESSION_POLICY.maxLimit.toFixed(2) + '.'
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

function estimatePlatformFee(limit: number): number {
  return roundMoney(Math.max(CREATE_SESSION_POLICY.minPlatformFee, limit * (CREATE_SESSION_POLICY.platformFeeBps / 10000)));
}

export function walletIdFromAddress(address: string): string {
  return address.toLowerCase();
}

export async function ensureWalletForAddress(address: string): Promise<WalletRecord> {
  const walletId = walletIdFromAddress(address);
  const wallet = await WalletModel.findOneAndUpdate(
    { walletId },
    {
      $set: { connected: true, address },
      $setOnInsert: {
        walletId,
        balance: DEFAULT_WALLET_BALANCE,
        currency: 'USDC'
      }
    },
    { upsert: true, new: true }
  );

  return wallet.toObject();
}

export async function seedWalletDemoSessions(walletId: string): Promise<void> {
  const count = await SessionModel.countDocuments({ ownerWalletId: walletId });
  if (count === 0) {
    await SessionModel.insertMany(seedForWallet(walletId), { ordered: true });
  }
}

export async function seedDemoData(): Promise<void> {
  await WalletModel.findOneAndUpdate(
    { walletId: DEMO_WALLET_ID },
    {
      $setOnInsert: {
        walletId: DEMO_WALLET_ID,
        connected: true,
        address: DEMO_WALLET_ADDRESS,
        balance: DEFAULT_WALLET_BALANCE,
        currency: 'USDC'
      }
    },
    { upsert: true, new: true }
  );

  await SessionModel.updateMany(
    { ownerWalletId: { $exists: false } },
    { $set: { ownerWalletId: DEMO_WALLET_ID } }
  );

  const sessionCount = await SessionModel.countDocuments({ ownerWalletId: DEMO_WALLET_ID });
  if (sessionCount === 0) {
    await SessionModel.insertMany(seedForWallet(DEMO_WALLET_ID, true), { ordered: true });
  }
}

async function getWalletDocument(walletId: string) {
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
  const limit = roundMoney(input.limit);
  validateCreateLimit(limit);

  if (input.currency !== CREATE_SESSION_POLICY.currency) {
    throw new ApiError(400, 'UNSUPPORTED_CURRENCY', 'FiberPass currently supports ' + CREATE_SESSION_POLICY.currency + ' sessions.');
  }

  const verifiedApp = getVerifiedApp(input.appId);
  if (input.appId && input.appId !== 'manual' && !verifiedApp) {
    throw new ApiError(400, 'APP_NOT_VERIFIED', 'Selected app is not available for FiberPass sessions.');
  }

  const expiryAt = validateExpiryAt(input.expiryAt);
  const serviceAddress = verifiedApp?.serviceAddress ?? input.serviceAddress;
  const appPermissions = verifiedApp?.permissions ?? input.appPermissions ?? [];
  const platformFeeEstimate = estimatePlatformFee(limit);
  const networkFeeEstimate = CREATE_SESSION_POLICY.estimatedNetworkFee;

  const wallet = await WalletModel.findOneAndUpdate(
    { walletId, balance: { $gte: limit } },
    { $inc: { balance: -limit } },
    { new: true }
  );

  if (!wallet) {
    throw new ApiError(400, 'INSUFFICIENT_WALLET_BALANCE', 'Wallet balance is too low for this FiberPass limit.');
  }

  try {
    await SessionModel.create({
      ownerWalletId: walletId,
      publicId: newPublicId(),
      name: verifiedApp?.name ?? input.name,
      serviceAddress,
      appId: verifiedApp?.id ?? input.appId,
      appUrl: verifiedApp?.url ?? input.appUrl,
      appTrustLevel: verifiedApp?.trustLevel ?? input.appTrustLevel,
      appPermissions,
      chargePolicy: verifiedApp?.chargePolicy ?? input.chargePolicy,
      expiryAt,
      platformFeeEstimate,
      networkFeeEstimate,
      spent: 0,
      limit,
      currency: input.currency,
      duration: input.duration,
      status: 'active',
      iconType: verifiedApp?.iconType ?? input.iconType,
      expiryTime: expiryAt ? expiryAt.toISOString() : input.expiryTime,
      autoMicroCharges: input.autoMicroCharges,
      singleUse: input.singleUse,
      logs: [newLog('Session Stream Limit Created')]
    });
  } catch (error) {
    await WalletModel.updateOne({ walletId }, { $inc: { balance: limit } });
    throw error;
  }

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish(`overview:${walletId}`, overview);
  return overview;
}

export async function topUpSession(publicId: string, walletId: string, amount = 1): Promise<SessionsOverviewDto> {
  const topUpAmount = roundMoney(amount);
  if (topUpAmount <= 0) {
    throw new ApiError(400, 'INVALID_TOP_UP_AMOUNT', 'Top up amount must be greater than zero.');
  }

  const session = await getSessionOrThrow(publicId, walletId);
  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Only active or paused sessions can be topped up.');
  }

  const wallet = await WalletModel.findOneAndUpdate(
    { walletId, balance: { $gte: topUpAmount } },
    { $inc: { balance: -topUpAmount } },
    { new: true }
  );

  if (!wallet) {
    throw new ApiError(400, 'INSUFFICIENT_WALLET_BALANCE', 'Wallet balance is too low for this top up.');
  }

  session.limit = roundMoney(session.limit + topUpAmount);
  prependLogs(session, newLog('Session Allocation Top Up', topUpAmount));
  await session.save();

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish(`overview:${walletId}`, overview);
  return overview;
}

export async function togglePauseSession(publicId: string, walletId: string): Promise<SessionsOverviewDto> {
  const session = await getSessionOrThrow(publicId, walletId);
  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Only active or paused sessions can be paused or resumed.');
  }

  session.status = session.status === 'paused' ? 'active' : 'paused';
  prependLogs(session, newLog(session.status === 'active' ? 'Session Stream Resumed' : 'Session Stream Paused'));
  await session.save();

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish(`overview:${walletId}`, overview);
  return overview;
}

export async function revokeSession(publicId: string, walletId: string): Promise<SessionsOverviewDto> {
  const session = await getSessionOrThrow(publicId, walletId);
  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Session is already closed.');
  }

  const refundAmount = roundMoney(Math.max(0, session.limit - session.spent));
  session.status = 'revoked';
  session.expiryTime = 'Revoked by Owner';
  prependLogs(session, newLog(`Session Revoked (Refunded $${refundAmount.toFixed(2)})`));
  await session.save();

  await WalletModel.updateOne({ walletId }, { $inc: { balance: refundAmount } });
  await fiberAdapter.settleSession({ sessionId: publicId, amount: refundAmount, currency: session.currency, reason: 'revoked' });

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish(`overview:${walletId}`, overview);
  return overview;
}

export async function settleSession(publicId: string, walletId: string): Promise<SessionsOverviewDto> {
  const session = await getSessionOrThrow(publicId, walletId);
  if (!OPEN_STATUSES.includes(session.status as SessionStatus)) {
    throw new ApiError(409, 'SESSION_CLOSED', 'Session is already closed.');
  }

  const refundAmount = roundMoney(Math.max(0, session.limit - session.spent));
  session.status = 'settled';
  session.expiryTime = 'Settled by User';
  prependLogs(session, newLog(`Session Settled (Refunded $${refundAmount.toFixed(2)})`));
  await session.save();

  await WalletModel.updateOne({ walletId }, { $inc: { balance: refundAmount } });
  await fiberAdapter.settleSession({ sessionId: publicId, amount: refundAmount, currency: session.currency, reason: 'settled' });

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish(`overview:${walletId}`, overview);
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
  const amount = roundMoney(input.amount);
  const attempt = await ChargeAttemptModel.create({
    attemptId: randomUUID(),
    sessionId: input.sessionId,
    appId: input.appId,
    apiKeyId: input.apiKeyId,
    amount: Math.max(0, amount),
    currency: 'USDC',
    type: input.type,
    status: 'pending',
    metadata: input.metadata
  });

  try {
    if (amount <= 0) {
      throw new ApiError(400, 'INVALID_CHARGE_AMOUNT', 'Charge amount must be greater than zero.');
    }

    const session = await getSessionOrThrow(input.sessionId);
    const ownerWalletId = session.ownerWalletId as string;
    attempt.ownerWalletId = ownerWalletId;
    attempt.currency = session.currency;

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
      session.expiryTime = 'Expired';
      prependLogs(session, newLog('Charge Blocked - Session Expired'));
      await session.save();
      await publishOverview(ownerWalletId);
      throw new ApiError(410, 'SESSION_EXPIRED', 'Session has expired; charges are blocked.');
    }

    const remaining = roundMoney(session.limit - session.spent);
    if (amount > remaining) {
      session.status = 'expired';
      session.expiryTime = 'Limit Exhausted';
      prependLogs(session, newLog('Charge Blocked - Spending Limit Exhausted'));
      await session.save();
      await fiberAdapter.settleSession({ sessionId: input.sessionId, amount: 0, currency: session.currency, reason: 'expired' });
      await publishOverview(ownerWalletId);
      throw new ApiError(402, 'SESSION_LIMIT_EXCEEDED', 'Charge exceeds the remaining FiberPass balance.');
    }

    await fiberAdapter.authorizeCharge({
      sessionId: input.sessionId,
      appAddress: session.serviceAddress,
      amount,
      currency: session.currency
    });

    const nextSpent = roundMoney(session.spent + amount);
    session.spent = nextSpent;
    prependLogs(session, newLog(input.type, amount));

    if (nextSpent >= session.limit) {
      session.status = 'expired';
      session.expiryTime = 'Limit Exhausted';
      prependLogs(session, newLog('Spending Limit Exhausted - Settled'));
      await fiberAdapter.settleSession({ sessionId: input.sessionId, amount: 0, currency: session.currency, reason: 'expired' });
    } else if (session.singleUse) {
      const refundAmount = roundMoney(Math.max(0, session.limit - session.spent));
      session.status = 'settled';
      session.expiryTime = 'Single-use charge completed';
      prependLogs(session, newLog('Single-use Session Settled (Refunded $' + refundAmount.toFixed(2) + ')'));
      await WalletModel.updateOne({ walletId: ownerWalletId }, { $inc: { balance: refundAmount } });
      await fiberAdapter.settleSession({ sessionId: input.sessionId, amount: refundAmount, currency: session.currency, reason: 'settled' });
    }

    await session.save();

    attempt.status = 'succeeded';
    attempt.resultingSpent = roundMoney(session.spent);
    attempt.remainingBalance = roundMoney(Math.max(0, session.limit - session.spent));
    await attempt.save();

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

export async function chargeRandomActiveSession(): Promise<SessionsOverviewDto | null> {
  const query: FilterQuery<SessionRecord> = { status: 'active', autoMicroCharges: true };
  const sessions = await SessionModel.find(query).lean<SessionLike[]>();
  if (sessions.length === 0) return null;

  const target = sessions[Math.floor(Math.random() * sessions.length)];
  const logTypes = [
    'Continuous Data Stream Tick',
    'API Inference Endpoint Charge',
    'Agent Network Routing Query',
    'Sub-second Layer-3 Gas Settlement',
    'Micro-billing Stream Tick'
  ];
  const amount = roundMoney(0.01 + Math.random() * 0.04);
  const type = logTypes[Math.floor(Math.random() * logTypes.length)];

  try {
    return await chargeSession({ sessionId: target.publicId, amount, type });
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 402) {
      return getSessionsOverview(target.ownerWalletId);
    }
    throw error;
  }
}

export function isValidIconType(iconType: string): iconType is IconType {
  return ICON_TYPES.includes(iconType as IconType);
}

export async function resetDemoData(): Promise<SessionsOverviewDto> {
  await Promise.all([SessionModel.deleteMany({}), WalletModel.deleteMany({})]);
  await seedDemoData();
  const overview = await getSessionsOverview(DEMO_WALLET_ID);
  liveEvents.publish(`overview:${DEMO_WALLET_ID}`, overview);
  return overview;
}
