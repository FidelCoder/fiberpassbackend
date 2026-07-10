import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from '../lib/errors.js';
import {
  APP_API_KEY_SCOPES,
  DEFAULT_APP_API_KEY_SCOPES,
  AppApiKeyModel,
  AppModel,
  type AppApiKeyRecord,
  type AppApiKeyScope,
  type AppRecord
} from '../models/app.model.js';
import { ChargeAttemptModel, type ChargeAttemptRecord } from '../models/chargeAttempt.model.js';
import { fallbackMinorUnits, fromMinorUnits } from '../lib/money.js';
import { writeAuditLog } from './audit.service.js';

export interface CreateDeveloperAppInput {
  name: string;
  serviceAddress: string;
  url?: string;
  category?: string;
  description?: string;
}

export interface AppDto {
  id: string;
  name: string;
  serviceAddress: string;
  url: string;
  category: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppApiKeyDto {
  id: string;
  appId: string;
  label: string;
  keyPrefix: string;
  status: string;
  scopes: AppApiKeyScope[];
  lastUsedAt?: string;
  createdAt: string;
}

export interface CreatedAppApiKeyDto extends AppApiKeyDto {
  secret: string;
}

export interface AppChargeAttemptDto {
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

export interface DeveloperAppOverviewDto extends AppDto {
  apiKeys: AppApiKeyDto[];
  chargeAttempts: AppChargeAttemptDto[];
}

export interface AppAuthContext {
  appId: string;
  keyId: string;
  ownerWalletId: string;
  serviceAddress: string;
  scopes: AppApiKeyScope[];
}

const APP_API_KEY_SCOPE_SET = new Set<string>(APP_API_KEY_SCOPES);

function newAppId(): string {
  return 'fp_app_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function newKeyId(): string {
  return 'fp_key_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function generateSecret(): string {
  return 'fp_live_' + randomBytes(32).toString('hex');
}

function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function normalizeAppApiKeyScopes(scopes?: readonly string[] | null): AppApiKeyScope[] {
  const normalized = (scopes ?? [])
    .map((scope) => scope.trim())
    .filter((scope): scope is AppApiKeyScope => APP_API_KEY_SCOPE_SET.has(scope));
  const unique = [...new Set(normalized)];
  return unique.length > 0 ? unique : [...DEFAULT_APP_API_KEY_SCOPES];
}

export function hasRequiredAppApiKeyScopes(scopes: readonly string[] | undefined | null, requiredScopes: readonly AppApiKeyScope[]): boolean {
  if (requiredScopes.length === 0) return true;
  const normalized = new Set(normalizeAppApiKeyScopes(scopes));
  return requiredScopes.every((scope) => normalized.has(scope));
}

function toAppDto(app: AppRecord & { createdAt?: Date; updatedAt?: Date }): AppDto {
  return {
    id: app.appId,
    name: app.name,
    serviceAddress: app.serviceAddress,
    url: app.url ?? '',
    category: app.category ?? 'API',
    description: app.description ?? '',
    status: app.status,
    createdAt: (app.createdAt ?? new Date()).toISOString(),
    updatedAt: (app.updatedAt ?? app.createdAt ?? new Date()).toISOString()
  };
}

function toApiKeyDto(key: AppApiKeyRecord & { createdAt?: Date; lastUsedAt?: Date | null }): AppApiKeyDto {
  return {
    id: key.keyId,
    appId: key.appId,
    label: key.label ?? 'Default key',
    keyPrefix: key.keyPrefix,
    status: key.status,
    scopes: normalizeAppApiKeyScopes(key.scopes),
    lastUsedAt: key.lastUsedAt?.toISOString(),
    createdAt: (key.createdAt ?? new Date()).toISOString()
  };
}

export function toAppChargeAttemptDto(attempt: ChargeAttemptRecord & { createdAt?: Date }): AppChargeAttemptDto {
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

async function getOwnedAppOrThrow(appId: string, walletId: string) {
  const app = await AppModel.findOne({ appId, ownerWalletId: walletId });
  if (!app) {
    throw new ApiError(404, 'APP_NOT_FOUND', 'Developer app was not found for this wallet.');
  }
  return app;
}

export async function createDeveloperApp(input: CreateDeveloperAppInput, walletId: string): Promise<DeveloperAppOverviewDto> {
  const app = await AppModel.create({
    appId: newAppId(),
    ownerWalletId: walletId,
    name: input.name,
    serviceAddress: input.serviceAddress,
    url: input.url ?? '',
    category: input.category ?? 'API',
    description: input.description ?? '',
    status: 'active'
  });

  await writeAuditLog({ actorWalletId: walletId, action: 'app.created', targetType: 'app', targetId: app.appId, metadata: { name: input.name } });

  return {
    ...toAppDto(app.toObject()),
    apiKeys: [],
    chargeAttempts: []
  };
}

export async function listDeveloperApps(walletId: string): Promise<{ apps: DeveloperAppOverviewDto[] }> {
  const apps = await AppModel.find({ ownerWalletId: walletId }).sort({ createdAt: -1 }).lean<(AppRecord & { createdAt?: Date; updatedAt?: Date })[]>();
  const appIds = apps.map((app) => app.appId);
  const [apiKeys, chargeAttempts] = await Promise.all([
    AppApiKeyModel.find({ ownerWalletId: walletId, appId: { $in: appIds } }).sort({ createdAt: -1 }).lean<(AppApiKeyRecord & { createdAt?: Date; lastUsedAt?: Date })[]>(),
    ChargeAttemptModel.find({ appId: { $in: appIds } }).sort({ createdAt: -1 }).limit(100).lean<(ChargeAttemptRecord & { createdAt?: Date })[]>()
  ]);

  return {
    apps: apps.map((app) => ({
      ...toAppDto(app),
      apiKeys: apiKeys.filter((key) => key.appId === app.appId).map(toApiKeyDto),
      chargeAttempts: chargeAttempts.filter((attempt) => attempt.appId === app.appId).slice(0, 20).map(toAppChargeAttemptDto)
    }))
  };
}

export async function createAppApiKey(appId: string, walletId: string, label = 'Default key', scopes?: readonly AppApiKeyScope[]): Promise<CreatedAppApiKeyDto> {
  await getOwnedAppOrThrow(appId, walletId);
  const keyId = newKeyId();
  const secret = generateSecret();
  const normalizedScopes = normalizeAppApiKeyScopes(scopes);
  const key = await AppApiKeyModel.create({
    keyId,
    appId,
    ownerWalletId: walletId,
    keyHash: hashApiKey(secret),
    keyPrefix: secret.slice(0, 18),
    label,
    scopes: normalizedScopes,
    status: 'active'
  });

  await writeAuditLog({ actorWalletId: walletId, action: 'app_api_key.created', targetType: 'app', targetId: appId, metadata: { keyId, keyPrefix: secret.slice(0, 18), scopes: normalizedScopes } });

  return {
    ...toApiKeyDto(key.toObject()),
    secret
  };
}

export async function revokeAppApiKey(appId: string, keyId: string, walletId: string): Promise<AppApiKeyDto> {
  await getOwnedAppOrThrow(appId, walletId);
  const key = await AppApiKeyModel.findOneAndUpdate(
    { appId, keyId, ownerWalletId: walletId },
    { $set: { status: 'revoked', revokedAt: new Date() } },
    { new: true }
  );
  if (!key) {
    throw new ApiError(404, 'API_KEY_NOT_FOUND', 'API key was not found for this app.');
  }
  await writeAuditLog({ actorWalletId: walletId, action: 'app_api_key.revoked', targetType: 'app', targetId: appId, metadata: { keyId, scopes: normalizeAppApiKeyScopes(key.scopes) } });
  return toApiKeyDto(key.toObject());
}

export async function authenticateAppApiKey(secret: string, routeAppId?: string, requiredScopes: readonly AppApiKeyScope[] = []): Promise<AppAuthContext> {
  const key = await AppApiKeyModel.findOne({ keyHash: hashApiKey(secret), status: 'active' });
  if (!key) {
    throw new ApiError(401, 'APP_API_KEY_INVALID', 'App API key is invalid or revoked.');
  }

  if (routeAppId && key.appId !== routeAppId) {
    throw new ApiError(403, 'APP_API_KEY_SCOPE_MISMATCH', 'API key cannot charge for this app.');
  }

  const scopes = normalizeAppApiKeyScopes(key.scopes);
  if (!hasRequiredAppApiKeyScopes(scopes, requiredScopes)) {
    throw new ApiError(403, 'APP_API_KEY_SCOPE_REQUIRED', 'API key is missing the required FiberPass app permission.');
  }

  const app = await AppModel.findOne({ appId: key.appId, status: 'active' }).lean<AppRecord>();
  if (!app) {
    throw new ApiError(403, 'APP_NOT_ACTIVE', 'Developer app is not active.');
  }

  key.lastUsedAt = new Date();
  await key.save();

  return {
    appId: key.appId,
    keyId: key.keyId,
    ownerWalletId: key.ownerWalletId,
    serviceAddress: app.serviceAddress,
    scopes
  };
}

export async function listAppChargeAttempts(walletId: string, appId: string): Promise<{ chargeAttempts: AppChargeAttemptDto[] }> {
  await getOwnedAppOrThrow(appId, walletId);
  const attempts = await ChargeAttemptModel.find({ appId }).sort({ createdAt: -1 }).limit(100).lean<(ChargeAttemptRecord & { createdAt?: Date })[]>();
  return { chargeAttempts: attempts.map(toAppChargeAttemptDto) };
}
