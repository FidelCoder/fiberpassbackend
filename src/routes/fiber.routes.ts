import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { ApiError } from '../lib/errors.js';
import { getFiberChannelStrategy, openFiberTestChannel } from '../services/fiberChannel.service.js';
import { runFiberLivePaymentTest } from '../services/fiberLiveTest.service.js';
import { getFiberNodeReadiness } from '../services/fiberNode.service.js';

export const fiberRouter = Router();

const openChannelSchema = z.object({
  peerId: z.string().trim().min(1).max(220).optional(),
  amount: z.coerce.number().positive().max(100000).optional()
});

const livePaymentTestSchema = z.object({
  paymentRequest: z.string().trim().min(16).max(4000),
  amount: z.coerce.number().positive().max(100000).optional()
});

function requireFiberOperator(request: Request, _response: Response, next: NextFunction): void {
  if (!env.CRON_SECRET) {
    next(new ApiError(503, 'OPERATOR_SECRET_NOT_CONFIGURED', 'CRON_SECRET must be configured before running Fiber operator actions.'));
    return;
  }
  if (request.headers.authorization !== 'Bearer ' + env.CRON_SECRET) {
    next(new ApiError(401, 'OPERATOR_UNAUTHORIZED', 'Invalid Fiber operator authorization.'));
    return;
  }
  next();
}

fiberRouter.get('/fiber/node/status', asyncHandler(async (_request, response) => {
  response.json(await getFiberNodeReadiness());
}));

fiberRouter.get('/fiber/node/readiness', asyncHandler(async (_request, response) => {
  response.json(await getFiberNodeReadiness());
}));

fiberRouter.get('/fiber/channels/strategy', asyncHandler(async (_request, response) => {
  response.json(await getFiberChannelStrategy());
}));

fiberRouter.post('/fiber/channels/test-open', requireFiberOperator, asyncHandler(async (request, response) => {
  const payload = openChannelSchema.parse(request.body ?? {});
  response.status(202).json(await openFiberTestChannel(payload));
}));

fiberRouter.post('/fiber/live-e2e', requireFiberOperator, asyncHandler(async (request, response) => {
  const payload = livePaymentTestSchema.parse(request.body ?? {});
  response.status(202).json(await runFiberLivePaymentTest(payload));
}));
