import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAppApiKey } from '../middleware/appAuth.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { createAppApiKey, createDeveloperApp, listAppChargeAttempts, listDeveloperApps, revokeAppApiKey } from '../services/app.service.js';
import { chargeSession } from '../services/session.service.js';
import type { AppAuthenticatedRequest } from '../types/appAuth.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const appSchema = z.object({
  name: z.string().trim().min(1).max(80),
  serviceAddress: z.string().trim().min(3).max(120),
  url: z.string().trim().url().max(200).optional().or(z.literal('')),
  category: z.string().trim().min(1).max(60).default('API'),
  description: z.string().trim().max(240).default('')
});

const keySchema = z.object({
  label: z.string().trim().min(1).max(80).default('Default key')
});

const paramsSchema = z.object({
  appId: z.string().trim().min(1),
  keyId: z.string().trim().min(1).optional()
});

const chargeSchema = z.object({
  sessionId: z.string().trim().min(1),
  amount: z.coerce.number().positive().max(100000),
  type: z.string().trim().min(1).max(120).default('App charge'),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const appsRouter = Router();

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
  const { label } = keySchema.parse(request.body ?? {});
  response.status(201).json(await createAppApiKey(appId, walletId, label));
}));

appsRouter.post('/apps/:appId/api-keys/:keyId/revoke', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { appId, keyId } = paramsSchema.parse(request.params);
  response.json(await revokeAppApiKey(appId, keyId ?? '', walletId));
}));

appsRouter.get('/apps/:appId/charges', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { appId } = paramsSchema.parse(request.params);
  response.json(await listAppChargeAttempts(walletId, appId));
}));

appsRouter.post('/apps/:appId/charges', requireAppApiKey, asyncHandler(async (request, response) => {
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
