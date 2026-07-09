import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { confirmWalletFundingRequest, createWalletFundingRequest, listWalletFunding, syncWalletFunding } from '../services/walletFunding.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const fundingRequestSchema = z.object({
  amount: z.coerce.number().positive().max(100000)
});

const fundingProofSchema = z.object({
  proofId: z.string().trim().min(8).max(180)
});

const fundingParamsSchema = z.object({
  fundingId: z.string().trim().min(1).max(80)
});

export const walletRouter = Router();

walletRouter.get('/wallet/funding', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json(await listWalletFunding(walletId));
}));

walletRouter.post('/wallet/funding', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { amount } = fundingRequestSchema.parse(request.body ?? {});
  response.status(201).json(await createWalletFundingRequest(walletId, amount));
}));


walletRouter.post('/wallet/funding/sync', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json(await syncWalletFunding(walletId));
}));

walletRouter.post('/wallet/funding/:fundingId/confirm', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { fundingId } = fundingParamsSchema.parse(request.params);
  const { proofId } = fundingProofSchema.parse(request.body ?? {});
  response.json(await confirmWalletFundingRequest(walletId, fundingId, proofId));
}));
