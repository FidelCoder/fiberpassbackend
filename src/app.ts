import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { env, isProduction } from './config/env.js';
import { ApiError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.middleware.js';
import { requestContext } from './middleware/requestContext.middleware.js';
import { securityHeaders } from './middleware/securityHeaders.middleware.js';
import { appsRouter } from './routes/apps.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { fiberRouter } from './routes/fiber.routes.js';
import { sessionsRouter } from './routes/sessions.routes.js';
import { walletRouter } from './routes/wallet.routes.js';
import { runPaymentWorkerOnce } from './services/automation.service.js';
import { runReconciliationWorkerOnce } from './services/reconciliation.service.js';
import { runDueSessionPayouts } from './services/session.service.js';
import { runWebhookWorkerOnce } from './services/webhook.service.js';

let mongoConnectionPromise: Promise<typeof mongoose> | undefined;

function parseCorsOrigin(origin: string): boolean | string[] {
  if (origin === '*') return true;
  return origin.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (!mongoConnectionPromise) {
    mongoConnectionPromise = mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 }).catch((error) => {
      mongoConnectionPromise = undefined;
      logger.error('mongo_connection_failed', {
        error: error instanceof Error ? error.message : error
      });
      throw error;
    });
  }
  return mongoConnectionPromise;
}

function verifyCronRequest(request: Request): boolean {
  if (!env.CRON_SECRET) return true;
  return request.headers.authorization === 'Bearer ' + env.CRON_SECRET;
}

async function runPaymentCron() {
  const scheduledPayouts = await runDueSessionPayouts({ limit: env.PAYMENT_WORKER_BATCH_SIZE });
  const automationPayments = await runPaymentWorkerOnce({
    workerId: 'vercel-cron-payment-worker',
    limit: env.PAYMENT_WORKER_BATCH_SIZE
  });
  const webhookDeliveries = await runWebhookWorkerOnce({
    workerId: 'vercel-cron-webhook-worker',
    limit: env.WEBHOOK_WORKER_BATCH_SIZE
  });
  const reconciliation = await runReconciliationWorkerOnce({
    workerId: 'vercel-cron-reconciliation-worker',
    limit: env.PAYMENT_WORKER_BATCH_SIZE
  });
  return { scheduledPayouts, automationPayments, webhookDeliveries, reconciliation };
}

export const app = express();

if (env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(requestContext);
app.use(securityHeaders);
app.use(createRateLimitMiddleware({ windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_GLOBAL_MAX, keyPrefix: 'global' }));
app.use(cors({ origin: parseCorsOrigin(env.FRONTEND_ORIGIN), methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));
function sendMeta(_request: Request, response: Response): void {
  response.json({
    service: 'fiberpass-api',
    mode: 'product',
    fiber: {
      provider: env.FIBER_PROVIDER,
      network: env.FIBER_NETWORK,
      rpcConfigured: Boolean(env.FIBER_RPC_URL)
    }
  });
}

app.get('/meta', sendMeta);
app.get('/v1/meta', sendMeta);
app.use(fiberRouter);
app.use('/v1', fiberRouter);

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'fiberpass-api',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    at: new Date().toISOString()
  });
});

app.use(async (_request, _response, next) => {
  try {
    await connectDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

app.get('/cron/payment-worker', async (request, response, next) => {
  try {
    if (!verifyCronRequest(request)) {
      response.status(401).json({ error: { code: 'CRON_UNAUTHORIZED', message: 'Invalid cron authorization.' } });
      return;
    }
    response.json(await runPaymentCron());
  } catch (error) {
    next(error);
  }
});

app.post('/cron/payment-worker', async (request, response, next) => {
  try {
    if (!verifyCronRequest(request)) {
      response.status(401).json({ error: { code: 'CRON_UNAUTHORIZED', message: 'Invalid cron authorization.' } });
      return;
    }
    response.json(await runPaymentCron());
  } catch (error) {
    next(error);
  }
});

app.use(authRouter);
app.use(appsRouter);
app.use(sessionsRouter);
app.use(walletRouter);
app.use('/v1', authRouter);
app.use('/v1', appsRouter);
app.use('/v1', sessionsRouter);
app.use('/v1', walletRouter);

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request payload failed validation.',
        details: isProduction ? undefined : error.issues
      }
    });
    return;
  }

  if (error instanceof ApiError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: isProduction ? undefined : error.details
      }
    });
    return;
  }

  logger.error('unhandled_request_error', { error });
  response.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Unexpected FiberPass API error.'
    }
  });
});

export default app;
