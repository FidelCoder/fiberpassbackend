import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { createRateLimitMiddleware } from '../middleware/rateLimit.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { createAuthChallenge, getWalletForAuthContext, revokeAuthToken, verifyAuthChallenge } from '../services/auth.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const challengeSchema = z.object({
  address: z.string().trim().min(1).optional()
});

const joyIdSignatureSchema = z.object({
  signature: z.string().trim().min(1),
  message: z.string().trim().min(1),
  pubkey: z.string().trim().min(1),
  challenge: z.string().trim().min(1),
  keyType: z.enum(['main_key', 'sub_key', 'main_session_key', 'sub_session_key']),
  alg: z.union([z.literal(-257), z.literal(-7)]),
  attestation: z.string().optional(),
  state: z.unknown().optional(),
  requestNetwork: z.enum(['nervos', 'nostr', 'ethereum', 'btc-p2tr', 'btc-p2wpkh', 'btc-auto']).optional()
}).passthrough();

const verifySchema = z.object({
  challengeId: z.string().uuid(),
  address: z.string().trim().min(1),
  signature: joyIdSignatureSchema
});

export const authRouter = Router();
const authRateLimit = createRateLimitMiddleware({ windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_AUTH_MAX, keyPrefix: 'auth' });

authRouter.post('/auth/challenge', authRateLimit, asyncHandler(async (request, response) => {
  const { address } = challengeSchema.parse(request.body ?? {});
  response.json(await createAuthChallenge(address));
}));

authRouter.post('/auth/verify', authRateLimit, asyncHandler(async (request, response) => {
  const payload = verifySchema.parse(request.body);
  response.json(await verifyAuthChallenge(payload));
}));

authRouter.get('/auth/me', requireAuth, asyncHandler(async (request, response) => {
  response.json(await getWalletForAuthContext((request as AuthenticatedRequest).auth));
}));

authRouter.post('/auth/logout', requireAuth, asyncHandler(async (request, response) => {
  const header = request.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (token) {
    await revokeAuthToken(token);
  }
  response.status(204).end();
}));
