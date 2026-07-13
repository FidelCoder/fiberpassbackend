import { randomUUID } from 'node:crypto';
import { ApiError } from '../lib/errors.js';
import { toMinorUnits, fromMinorUnits } from '../lib/money.js';
import { writeAuditLog } from './audit.service.js';
import { fiberAdapter, hashFiberPaymentRequest } from './fiberAdapter.js';
import { getFiberNodeReadiness } from './fiberNode.service.js';

export interface FiberLivePaymentTestInput {
  paymentRequest: string;
  amount?: number;
  actorWalletId?: string;
}

export interface FiberLivePaymentTestResult {
  ok: true;
  sessionId: string;
  amount: number;
  amountMinor: number;
  paymentRequestHash: string;
  proofId: string;
  proofType: 'fiber_payment';
  provider: string;
  network: string;
  readinessAtStart: string;
  raw?: unknown;
}

export async function runFiberLivePaymentTest(input: FiberLivePaymentTestInput): Promise<FiberLivePaymentTestResult> {
  const readiness = await getFiberNodeReadiness();
  if (readiness.paymentExecution.status === 'blocked') {
    throw new ApiError(409, 'FIBER_NODE_NOT_READY', 'Fiber node readiness is blocked; fix operator alerts before a live payment test.');
  }

  const amountMinor = toMinorUnits(String(input.amount ?? 0.01), 'CKB');
  if (amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_TEST_AMOUNT', 'Live Fiber payment test amount must be greater than zero.');
  }

  const sessionId = 'fp_live_fiber_test_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const result = await fiberAdapter.executePayment({
    sessionId,
    appAddress: 'fiberpass-live-e2e',
    amountMinor,
    currency: 'CKB',
    paymentRequest: input.paymentRequest,
    metadata: { liveE2e: true }
  });

  await writeAuditLog({
    actorWalletId: input.actorWalletId,
    action: 'fiber.live_payment_test_succeeded',
    targetType: 'fiber_payment_test',
    targetId: sessionId,
    metadata: { proofId: result.proofId, paymentRequestHash: result.paymentRequestHash, amountMinor }
  });

  return {
    ok: true,
    sessionId,
    amount: fromMinorUnits(amountMinor, 'CKB'),
    amountMinor,
    paymentRequestHash: hashFiberPaymentRequest(input.paymentRequest),
    proofId: result.proofId,
    proofType: result.proofType,
    provider: result.provider,
    network: result.network,
    readinessAtStart: readiness.readiness,
    raw: result.raw
  };
}
