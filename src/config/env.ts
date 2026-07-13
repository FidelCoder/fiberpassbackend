import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== 'string') return value;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;

  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/fiberpass'),
  FRONTEND_ORIGIN: z.string().default('http://localhost:3000'),
  PUBLIC_APP_URL: z.string().url().optional().default('http://localhost:3000'),
  FIBER_NETWORK: z.string().default('testnet'),
  FIBER_PROVIDER: z.literal('rpc').default('rpc'),
  FIBER_RPC_URL: z.string().min(1).default('http://127.0.0.1:8227'),
  FIBER_API_KEY: z.string().optional().default(''),
  FIBER_PEER_ID: z.string().optional().default(''),
  FIBER_NODE_MIN_PEERS: z.coerce.number().int().nonnegative().default(1),
  FIBER_NODE_MIN_ACTIVE_CHANNELS: z.coerce.number().int().nonnegative().default(1),
  FIBER_NODE_MIN_OUTBOUND_LIQUIDITY_CKB: z.coerce.number().nonnegative().default(0.01),
  FIBER_TARGET_PEER_IDS: z.string().optional().default(''),
  FIBER_TEST_CHANNEL_AMOUNT_CKB: z.coerce.number().positive().default(0.01),
  FIBERPASS_DAILY_SESSION_SPEND_LIMIT_CKB: z.coerce.number().positive().default(100000),
  FIBERPASS_TREASURY_ADDRESS: z.string().optional().default(''),
  FIBERPASS_VAULT_CODE_HASH: z.string().optional().default(''),
  FIBERPASS_VAULT_HASH_TYPE: z.enum(['data', 'type', 'data1', 'data2']).default('type'),
  FIBERPASS_VAULT_CELL_DEP_TX_HASH: z.string().optional().default(''),
  FIBERPASS_VAULT_CELL_DEP_INDEX: z.string().optional().default(''),
  FIBERPASS_VAULT_CELL_DEP_TYPE: z.enum(['code', 'depGroup', 'dep_group']).default('code'),
  FIBERPASS_OPERATOR_LOCK_HASH: z.string().optional().default(''),
  FIBERPASS_OPERATOR_PRIVATE_KEY: z.string().optional().default(''),
  CKB_TESTNET_RPC_URL: z.string().url().default('https://testnet.ckb.dev'),
  CKB_TESTNET_INDEXER_URL: z.string().url().default('https://testnet.ckb.dev'),
  JOYID_SERVER_URL: z.string().url().default('https://api.testnet.joyid.dev/api/v1'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanFromEnv.default(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  EMAIL_FROM_ADDRESS: z.string().email().default('xbeach329@gmail.com'),
  EMAIL_FROM_NAME: z.string().default('FiberPass'),
  EMAIL_DEFAULT_TIME_ZONE: z.string().optional().default('Africa/Nairobi'),
  RECIPIENT_MAGIC_LINK_TTL_HOURS: z.coerce.number().int().positive().default(72),
  REQUEST_BODY_LIMIT: z.string().default('128kb'),
  TRUST_PROXY: booleanFromEnv.default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_APP_CHARGE_MAX: z.coerce.number().int().positive().default(120),
  PAYMENT_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  PAYMENT_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  WEBHOOK_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  CRON_SECRET: z.string().optional().default(""),
  AUTOMATION_MAX_INVOICE_CKB: z.coerce.number().positive().default(1000),
  AUTOMATION_MAX_BATCH_CKB: z.coerce.number().positive().default(5000),
  AUTOMATION_DAILY_LIMIT_CKB: z.coerce.number().positive().default(10000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.FRONTEND_ORIGIN === '*') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FRONTEND_ORIGIN'],
      message: 'FRONTEND_ORIGIN must be an explicit allowlist in production.'
    });
  }

  if (env.NODE_ENV === 'production') {
    const localHosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);
    const isLocalUrl = (value: string): boolean => {
      try {
        return localHosts.has(new URL(value).hostname);
      } catch {
        return false;
      }
    };

    if (isLocalUrl(env.FIBER_RPC_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIBER_RPC_URL'],
        message: 'FIBER_RPC_URL must point to a reachable HTTPS Fiber RPC gateway in production.'
      });
    }

    if (isLocalUrl(env.PUBLIC_APP_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_APP_URL'],
        message: 'PUBLIC_APP_URL must be the deployed frontend URL in production.'
      });
    }

    if (!env.CRON_SECRET.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CRON_SECRET'],
        message: 'CRON_SECRET is required in production for worker and operator endpoints.'
      });
    }
  }
});

export const env = envSchema.parse(process.env);
export const isProduction = env.NODE_ENV === 'production';
