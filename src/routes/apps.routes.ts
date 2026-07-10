import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { FIBER_CKB_ADDRESS_ERROR, isFiberCkbAddress } from '../lib/fiberAddress.js';
import { createRateLimitMiddleware, hashRateLimitKey } from '../middleware/rateLimit.middleware.js';
import { requireAppApiKeyWithScopes } from '../middleware/appAuth.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { APP_API_KEY_SCOPES } from '../models/app.model.js';
import { createAppApiKey, createDeveloperApp, listAppChargeAttempts, listDeveloperApps, revokeAppApiKey } from '../services/app.service.js';
import { createRecipient, disableRecipient, listRecipients, updateRecipient, type AutomationActor } from '../services/automation.service.js';
import { chargeSession } from '../services/session.service.js';
import type { AppAuthenticatedRequest } from '../types/appAuth.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const appSchema = z.object({
  name: z.string().trim().min(1).max(80),
  serviceAddress: z.string().trim().min(1).max(190).refine(isFiberCkbAddress, FIBER_CKB_ADDRESS_ERROR),
  url: z.string().trim().url().max(200).optional().or(z.literal('')),
  category: z.string().trim().min(1).max(60).default('API'),
  description: z.string().trim().max(240).default('')
});

const appApiKeyScopeSchema = z.enum(APP_API_KEY_SCOPES);

const keySchema = z.object({
  label: z.string().trim().min(1).max(80).default('Default key'),
  scopes: z.array(appApiKeyScopeSchema).max(APP_API_KEY_SCOPES.length).optional()
});

const paramsSchema = z.object({
  appId: z.string().trim().min(1),
  keyId: z.string().trim().min(1).optional(),
  recipientId: z.string().trim().min(1).optional()
});

const chargeSchema = z.object({
  sessionId: z.string().trim().min(1),
  amount: z.coerce.number().positive().max(100000),
  type: z.string().trim().min(1).max(120).default('App charge'),
  metadata: z.record(z.string(), z.unknown()).optional()
});


const recipientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  serviceAddress: z.string().trim().min(1).max(190).refine(isFiberCkbAddress, FIBER_CKB_ADDRESS_ERROR),
  externalId: z.string().trim().max(120).optional().or(z.literal('')),
  invoiceEndpoint: z.string().trim().url().max(240).optional().or(z.literal('')),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const recipientUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  serviceAddress: z.string().trim().min(1).max(190).refine(isFiberCkbAddress, FIBER_CKB_ADDRESS_ERROR).optional(),
  externalId: z.string().trim().max(120).optional().or(z.literal('')),
  invoiceEndpoint: z.string().trim().url().max(240).optional().or(z.literal('')),
  metadata: z.record(z.string(), z.unknown()).optional()
});

function walletAutomationActor(request: Request, appId: string): AutomationActor {
  return {
    appId,
    ownerWalletId: (request as AuthenticatedRequest).auth.walletId,
    source: 'wallet'
  };
}

function appKeyAutomationActor(request: Request): AutomationActor {
  const { appId, ownerWalletId, keyId } = (request as AppAuthenticatedRequest).appAuth;
  return {
    appId,
    ownerWalletId,
    keyId,
    source: 'app_api_key'
  };
}

export const appsRouter = Router();
const appChargeRateLimit = createRateLimitMiddleware({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_APP_CHARGE_MAX,
  keyPrefix: 'app-charge',
  keyGenerator: (request: Request) => hashRateLimitKey(request.header('x-fiberpass-api-key') || request.header('authorization') || request.ip || 'unknown')
});

appsRouter.get('/apps', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json(await listDeveloperApps(walletId));
}));

appsRouter.post('/apps', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const payload = appSchema.parse(request.body);
  response.status(201).json(await createDeveloperApp(payload, walletId));
}));

appsRouter.post('/apps/:appId/api-keys', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { appId } = paramsSchema.parse(request.params);
  const { label, scopes } = keySchema.parse(request.body ?? {});
  response.status(201).json(await createAppApiKey(appId, walletId, label, scopes));
}));

appsRouter.post('/apps/:appId/api-keys/:keyId/revoke', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { appId, keyId } = paramsSchema.parse(request.params);
  response.json(await revokeAppApiKey(appId, keyId ?? '', walletId));
}));


appsRouter.get('/apps/:appId/recipients', requireAuth, asyncHandler(async (request, response) => {
  const { appId } = paramsSchema.parse(request.params);
  response.json(await listRecipients(walletAutomationActor(request, appId)));
}));

appsRouter.post('/apps/:appId/recipients', requireAuth, asyncHandler(async (request, response) => {
  const { appId } = paramsSchema.parse(request.params);
  const payload = recipientSchema.parse(request.body ?? {});
  response.status(201).json(await createRecipient(walletAutomationActor(request, appId), payload));
}));

appsRouter.patch('/apps/:appId/recipients/:recipientId', requireAuth, asyncHandler(async (request, response) => {
  const { appId, recipientId } = paramsSchema.parse(request.params);
  const payload = recipientUpdateSchema.parse(request.body ?? {});
  response.json(await updateRecipient(walletAutomationActor(request, appId), recipientId ?? '', payload));
}));

appsRouter.post('/apps/:appId/recipients/:recipientId/disable', requireAuth, asyncHandler(async (request, response) => {
  const { appId, recipientId } = paramsSchema.parse(request.params);
  response.json(await disableRecipient(walletAutomationActor(request, appId), recipientId ?? ''));
}));

appsRouter.get('/apps/:appId/automation/recipients', requireAppApiKeyWithScopes(['recipients:read']), asyncHandler(async (request, response) => {
  response.json(await listRecipients(appKeyAutomationActor(request)));
}));

appsRouter.post('/apps/:appId/automation/recipients', requireAppApiKeyWithScopes(['recipients:write']), asyncHandler(async (request, response) => {
  const payload = recipientSchema.parse(request.body ?? {});
  response.status(201).json(await createRecipient(appKeyAutomationActor(request), payload));
}));

appsRouter.patch('/apps/:appId/automation/recipients/:recipientId', requireAppApiKeyWithScopes(['recipients:write']), asyncHandler(async (request, response) => {
  const { recipientId } = paramsSchema.parse(request.params);
  const payload = recipientUpdateSchema.parse(request.body ?? {});
  response.json(await updateRecipient(appKeyAutomationActor(request), recipientId ?? '', payload));
}));

appsRouter.post('/apps/:appId/automation/recipients/:recipientId/disable', requireAppApiKeyWithScopes(['recipients:write']), asyncHandler(async (request, response) => {
  const { recipientId } = paramsSchema.parse(request.params);
  response.json(await disableRecipient(appKeyAutomationActor(request), recipientId ?? ''));
}));

appsRouter.get('/apps/:appId/charges', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { appId } = paramsSchema.parse(request.params);
  response.json(await listAppChargeAttempts(walletId, appId));
}));

appsRouter.post('/apps/:appId/charges', appChargeRateLimit, requireAppApiKeyWithScopes(['charges:create']), asyncHandler(async (request, response) => {
  const { appId, keyId, serviceAddress } = (request as AppAuthenticatedRequest).appAuth;
  const payload = chargeSchema.parse(request.body);
  const overview = await chargeSession({
    sessionId: payload.sessionId,
    amount: payload.amount,
    type: payload.type,
    metadata: payload.metadata,
    appId,
    apiKeyId: keyId,
    appServiceAddress: serviceAddress
  });
  response.json({ ok: true, overview });
}));
