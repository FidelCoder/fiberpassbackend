import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { FIBER_CKB_ADDRESS_ERROR, isFiberCkbAddress } from '../lib/fiberAddress.js';
import { createRateLimitMiddleware, hashRateLimitKey } from '../middleware/rateLimit.middleware.js';
import { requireAppApiKeyWithScopes } from '../middleware/appAuth.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { APP_API_KEY_SCOPES } from '../models/app.model.js';
import { configureAppWebhook, createAppApiKey, createDeveloperApp, listAppChargeAttempts, listDeveloperApps, revokeAppApiKey } from '../services/app.service.js';
import { createInvoice, createInvoiceBatch, createRecipient, disableRecipient, listInvoices, listPaymentBatches, listPaymentJobs, listRecipients, queueInvoice, queueInvoiceBatch, updateRecipient, type AutomationActor } from '../services/automation.service.js';
import { chargeSession } from '../services/session.service.js';
import { listWebhookDeliveries } from '../services/webhook.service.js';
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
  recipientId: z.string().trim().min(1).optional(),
  invoiceId: z.string().trim().min(1).optional(),
  batchId: z.string().trim().min(1).optional()
});

const chargeSchema = z.object({
  sessionId: z.string().trim().min(1),
  amount: z.coerce.number().positive().max(100000),
  type: z.string().trim().min(1).max(120).default('App charge'),
  idempotencyKey: z.string().trim().min(8).max(160),
  serviceReference: z.string().trim().max(160).optional().or(z.literal('')),
  paymentRequest: z.string().trim().max(4000).optional().or(z.literal('')),
  fiberInvoice: z.string().trim().max(4000).optional().or(z.literal('')),
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


const invoiceSchema = z.object({
  sessionId: z.string().trim().min(1),
  recipientId: z.string().trim().min(1),
  amount: z.coerce.number().positive().max(100000),
  type: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(240).optional().or(z.literal('')),
  memo: z.string().trim().max(240).optional().or(z.literal('')),
  externalReference: z.string().trim().max(120).optional().or(z.literal('')),
  idempotencyKey: z.string().trim().max(160).optional().or(z.literal('')),
  fiberInvoice: z.string().trim().max(2000).optional().or(z.literal('')),
  dueAt: z.string().trim().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const invoiceBatchSchema = z.object({
  sessionId: z.string().trim().min(1),
  description: z.string().trim().max(240).optional().or(z.literal('')),
  externalReference: z.string().trim().max(120).optional().or(z.literal('')),
  idempotencyKey: z.string().trim().max(160).optional().or(z.literal('')),
  metadata: z.record(z.string(), z.unknown()).optional(),
  invoices: z.array(invoiceSchema.omit({ sessionId: true })).min(1).max(100)
});

const invoiceQuerySchema = z.object({
  sessionId: z.string().trim().min(1).optional()
});

const webhookSchema = z.object({
  webhookUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
  signingSecret: z.string().trim().min(16).max(200).optional().or(z.literal(''))
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

appsRouter.post('/apps/:appId/webhook', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { appId } = paramsSchema.parse(request.params);
  const payload = webhookSchema.parse(request.body ?? {});
  response.json(await configureAppWebhook({
    appId,
    ownerWalletId: walletId,
    webhookUrl: payload.webhookUrl || undefined,
    signingSecret: payload.signingSecret || undefined
  }));
}));

appsRouter.get('/apps/:appId/webhook-deliveries', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { appId } = paramsSchema.parse(request.params);
  response.json(await listWebhookDeliveries(walletId, appId));
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


appsRouter.get('/apps/:appId/invoices', requireAuth, asyncHandler(async (request, response) => {
  const { appId } = paramsSchema.parse(request.params);
  const query = invoiceQuerySchema.parse(request.query ?? {});
  response.json(await listInvoices(walletAutomationActor(request, appId), query.sessionId));
}));

appsRouter.post('/apps/:appId/invoices', requireAuth, asyncHandler(async (request, response) => {
  const { appId } = paramsSchema.parse(request.params);
  const payload = invoiceSchema.parse(request.body ?? {});
  response.status(201).json(await createInvoice(walletAutomationActor(request, appId), payload));
}));

appsRouter.post('/apps/:appId/invoice-batches', requireAuth, asyncHandler(async (request, response) => {
  const { appId } = paramsSchema.parse(request.params);
  const payload = invoiceBatchSchema.parse(request.body ?? {});
  response.status(201).json(await createInvoiceBatch(walletAutomationActor(request, appId), payload));
}));

appsRouter.get('/apps/:appId/invoice-batches', requireAuth, asyncHandler(async (request, response) => {
  const { appId } = paramsSchema.parse(request.params);
  const query = invoiceQuerySchema.parse(request.query ?? {});
  response.json(await listPaymentBatches(walletAutomationActor(request, appId), query.sessionId));
}));

appsRouter.get('/apps/:appId/payment-jobs', requireAuth, asyncHandler(async (request, response) => {
  const { appId } = paramsSchema.parse(request.params);
  const query = invoiceQuerySchema.parse(request.query ?? {});
  response.json(await listPaymentJobs(walletAutomationActor(request, appId), query.sessionId));
}));

appsRouter.post('/apps/:appId/invoices/:invoiceId/queue', requireAuth, asyncHandler(async (request, response) => {
  const { appId, invoiceId } = paramsSchema.parse(request.params);
  response.json(await queueInvoice(walletAutomationActor(request, appId), invoiceId ?? ''));
}));

appsRouter.post('/apps/:appId/invoice-batches/:batchId/queue', requireAuth, asyncHandler(async (request, response) => {
  const { appId, batchId } = paramsSchema.parse(request.params);
  response.json(await queueInvoiceBatch(walletAutomationActor(request, appId), batchId ?? ''));
}));

appsRouter.get('/apps/:appId/automation/invoices', requireAppApiKeyWithScopes(['invoices:create']), asyncHandler(async (request, response) => {
  const query = invoiceQuerySchema.parse(request.query ?? {});
  response.json(await listInvoices(appKeyAutomationActor(request), query.sessionId));
}));

appsRouter.post('/apps/:appId/automation/invoices', requireAppApiKeyWithScopes(['invoices:create']), asyncHandler(async (request, response) => {
  const payload = invoiceSchema.parse(request.body ?? {});
  response.status(201).json(await createInvoice(appKeyAutomationActor(request), payload));
}));

appsRouter.post('/apps/:appId/automation/invoice-batches', requireAppApiKeyWithScopes(['invoices:create']), asyncHandler(async (request, response) => {
  const payload = invoiceBatchSchema.parse(request.body ?? {});
  response.status(201).json(await createInvoiceBatch(appKeyAutomationActor(request), payload));
}));

appsRouter.get('/apps/:appId/automation/invoice-batches', requireAppApiKeyWithScopes(['invoices:create']), asyncHandler(async (request, response) => {
  const query = invoiceQuerySchema.parse(request.query ?? {});
  response.json(await listPaymentBatches(appKeyAutomationActor(request), query.sessionId));
}));

appsRouter.get('/apps/:appId/automation/payment-jobs', requireAppApiKeyWithScopes(['payments:queue']), asyncHandler(async (request, response) => {
  const query = invoiceQuerySchema.parse(request.query ?? {});
  response.json(await listPaymentJobs(appKeyAutomationActor(request), query.sessionId));
}));

appsRouter.post('/apps/:appId/automation/invoices/:invoiceId/queue', requireAppApiKeyWithScopes(['payments:queue']), asyncHandler(async (request, response) => {
  const { invoiceId } = paramsSchema.parse(request.params);
  response.json(await queueInvoice(appKeyAutomationActor(request), invoiceId ?? ''));
}));

appsRouter.post('/apps/:appId/automation/invoice-batches/:batchId/queue', requireAppApiKeyWithScopes(['payments:queue']), asyncHandler(async (request, response) => {
  const { batchId } = paramsSchema.parse(request.params);
  response.json(await queueInvoiceBatch(appKeyAutomationActor(request), batchId ?? ''));
}));

appsRouter.get('/apps/:appId/charges', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { appId } = paramsSchema.parse(request.params);
  response.json(await listAppChargeAttempts(walletId, appId));
}));

appsRouter.post('/apps/:appId/charges', appChargeRateLimit, requireAppApiKeyWithScopes(['charges:create']), asyncHandler(async (request, response) => {
  const { appId, keyId, serviceAddress } = (request as AppAuthenticatedRequest).appAuth;
  const payload = chargeSchema.parse(request.body);
  const paymentRequest = payload.paymentRequest || payload.fiberInvoice || undefined;
  const metadata = {
    ...(payload.metadata ?? {}),
    idempotencyKey: payload.idempotencyKey,
    ...(payload.serviceReference ? { serviceReference: payload.serviceReference } : {}),
    ...(paymentRequest ? { fiberInvoice: paymentRequest, paymentRequest } : {})
  };
  const overview = await chargeSession({
    sessionId: payload.sessionId,
    amount: payload.amount,
    type: payload.type,
    idempotencyKey: payload.idempotencyKey,
    serviceReference: payload.serviceReference || undefined,
    paymentRequest,
    metadata,
    appId,
    apiKeyId: keyId,
    appServiceAddress: serviceAddress
  });
  response.json({ ok: true, overview });
}));
