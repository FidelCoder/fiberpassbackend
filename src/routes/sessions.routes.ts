import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { FIBER_CKB_ADDRESS_ERROR, isFiberCkbAddress } from '../lib/fiberAddress.js';
import { liveEvents } from '../lib/liveEvents.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  CREATE_SESSION_POLICY,
  claimRecipientWallet,
  createSession,
  getCreateSessionPolicy,
  getRecipientClaim,
  getSessionsOverview,
  isValidIconType,
  isValidPaymentPurpose,
  isValidReleaseCadence,
  resendRecipientInvites,
  runDueSessionPayouts,
  revokeSession,
  settleSession,
  togglePauseSession,
  topUpSession
} from '../services/session.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const recipientWalletSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(190).optional().or(z.literal('')).refine((value) => !value || isFiberCkbAddress(value), FIBER_CKB_ADDRESS_ERROR),
  email: z.string().trim().email().max(190).optional().or(z.literal('')),
  amount: z.coerce.number().positive().max(CREATE_SESSION_POLICY.maxLimit).optional(),
  fiberInvoice: z.string().trim().min(16, 'Enter a full Fiber invoice/payment request; short placeholders cannot be paid.').max(2000).optional()
}).refine((value) => Boolean(value.address || value.email), 'Each recipient needs a CKB wallet address or email.');

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  serviceAddress: z.string().trim().min(1).max(190).refine(isFiberCkbAddress, FIBER_CKB_ADDRESS_ERROR),
  appId: z.string().trim().min(1).max(80).optional(),
  appUrl: z.string().trim().url().max(200).optional(),
  appTrustLevel: z.string().trim().min(1).max(40).optional(),
  appPermissions: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  chargePolicy: z.string().trim().min(1).max(180).optional(),
  paymentPurpose: z.string().trim().refine(isValidPaymentPurpose, 'Invalid payment purpose').optional(),
  recipientName: z.string().trim().max(120).optional().or(z.literal('')),
  recipientAddress: z.string().trim().max(190).optional().or(z.literal('')).refine((value) => !value || isFiberCkbAddress(value), FIBER_CKB_ADDRESS_ERROR),
  recipientWallets: z.array(recipientWalletSchema).max(25).optional(),
  paymentReference: z.string().trim().max(120).optional().or(z.literal('')),
  releaseCadence: z.string().trim().refine(isValidReleaseCadence, 'Invalid release cadence').optional(),
  nextReleaseAt: z.string().datetime().optional(),
  maxChargeAmount: z.coerce.number().positive().max(CREATE_SESSION_POLICY.maxLimit).optional(),
  conditionSummary: z.string().trim().max(240).optional().or(z.literal('')),
  expiryAt: z.string().datetime().optional(),
  platformFeeEstimate: z.coerce.number().min(0).max(100000).optional(),
  networkFeeEstimate: z.coerce.number().min(0).max(100000).optional(),
  limit: z.coerce.number().min(CREATE_SESSION_POLICY.minLimit).max(CREATE_SESSION_POLICY.maxLimit),
  currency: z.literal(CREATE_SESSION_POLICY.currency).default(CREATE_SESSION_POLICY.currency),
  duration: z.string().trim().min(1).max(40),
  expiryTime: z.string().trim().min(1).max(120),
  autoMicroCharges: z.coerce.boolean().default(true),
  singleUse: z.coerce.boolean().default(false),
  iconType: z.string().refine(isValidIconType, 'Invalid icon type')
});

const topUpSchema = z.object({
  amount: z.coerce.number().positive().max(100000).default(1)
});

const paramsSchema = z.object({ id: z.string().min(1) });
const claimParamsSchema = z.object({ token: z.string().trim().min(32).max(200) });
const claimWalletSchema = z.object({
  address: z.string().trim().min(1).max(190).refine(isFiberCkbAddress, FIBER_CKB_ADDRESS_ERROR),
  timeZone: z.string().trim().min(1).max(80).optional()
});

export const sessionsRouter = Router();

sessionsRouter.get('/recipient-claims/:token', asyncHandler(async (request, response) => {
  const { token } = claimParamsSchema.parse(request.params);
  response.json(await getRecipientClaim(token));
}));

sessionsRouter.post('/recipient-claims/:token', asyncHandler(async (request, response) => {
  const { token } = claimParamsSchema.parse(request.params);
  const { address, timeZone } = claimWalletSchema.parse(request.body ?? {});
  response.json(await claimRecipientWallet(token, address, timeZone));
}));

sessionsRouter.get('/sessions/create-policy', requireAuth, asyncHandler(async (_request, response) => {
  response.json(getCreateSessionPolicy());
}));

sessionsRouter.get('/sessions', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  await runDueSessionPayouts({ ownerWalletId: walletId, limit: 5 }).catch(() => undefined);
  response.json(await getSessionsOverview(walletId));
}));

sessionsRouter.post('/sessions/payouts/sync', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const payoutSync = await runDueSessionPayouts({ ownerWalletId: walletId, limit: 25 });
  const overview = await getSessionsOverview(walletId);
  response.json({ ...overview, payoutSync });
}));

sessionsRouter.post('/sessions', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const payload = createSessionSchema.parse(request.body);
  response.status(201).json(await createSession(payload, walletId));
}));

sessionsRouter.post('/sessions/:id/top-up', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  const { amount } = topUpSchema.parse(request.body ?? {});
  response.json(await topUpSession(id, walletId, amount));
}));

sessionsRouter.post('/sessions/:id/recipient-invites/resend', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  response.json(await resendRecipientInvites(id, walletId));
}));

sessionsRouter.post('/sessions/:id/toggle-pause', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  response.json(await togglePauseSession(id, walletId));
}));

sessionsRouter.post('/sessions/:id/revoke', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  response.json(await revokeSession(id, walletId));
}));

sessionsRouter.post('/sessions/:id/settle', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  response.json(await settleSession(id, walletId));
}));

sessionsRouter.post('/sessions/:id/close', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  response.json(await settleSession(id, walletId));
}));


sessionsRouter.get('/events', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (eventName: string, payload: unknown) => {
    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const eventName = `overview:${walletId}`;
  const overviewHandler = (payload: unknown) => send('overview', payload);
  liveEvents.on(eventName, overviewHandler);

  send('overview', await getSessionsOverview(walletId));
  const heartbeat = setInterval(() => send('heartbeat', { at: new Date().toISOString() }), 30000);

  request.on('close', () => {
    clearInterval(heartbeat);
    liveEvents.off(eventName, overviewHandler);
    response.end();
  });
}));
