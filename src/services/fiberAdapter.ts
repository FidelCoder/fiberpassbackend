import { createHash } from 'node:crypto';
import { ApiError } from '../lib/errors.js';
import { fiberProvider, type FiberProvider, type FiberProviderKind } from './fiberProvider.js';

const MIN_FIBER_PAYMENT_REQUEST_LENGTH = 16;

export interface FiberPaymentExecutionInput {
  sessionId: string;
  networkSessionId?: string;
  appAddress: string;
  amountMinor: number;
  currency: string;
  paymentRequest?: string;
  metadata?: Record<string, unknown>;
}

export interface FiberPaymentExecutionResult {
  provider: FiberProviderKind;
  network: string;
  proofId: string;
  proofType: 'fiber_payment';
  paymentRequestHash?: string;
  raw?: unknown;
}

export function normalizeFiberPaymentRequest(value?: string): string {
  const paymentRequest = value?.trim() ?? '';
  if (!paymentRequest) {
    throw new ApiError(400, 'FIBER_INVOICE_REQUIRED', 'A Fiber invoice/payment request is required before an app can charge this FiberPass.');
  }
  if (paymentRequest.length < MIN_FIBER_PAYMENT_REQUEST_LENGTH) {
    throw new ApiError(400, 'FIBER_INVOICE_INVALID', 'Fiber payment request is too short to execute.');
  }
  return paymentRequest;
}

export function hashFiberPaymentRequest(value: string): string {
  return createHash('sha256').update(normalizeFiberPaymentRequest(value)).digest('hex');
}

export class FiberAdapter {
  constructor(private readonly provider: FiberProvider = fiberProvider) {}

  async executePayment(input: FiberPaymentExecutionInput): Promise<FiberPaymentExecutionResult> {
    const keysendTargetPubkey = typeof input.metadata?.fiberKeysendTargetPubkey === 'string'
      ? input.metadata.fiberKeysendTargetPubkey.trim()
      : '';
    const paymentRequest = keysendTargetPubkey ? undefined : normalizeFiberPaymentRequest(input.paymentRequest);
    try {
      const result = await this.provider.authorizeCharge({
        sessionId: input.sessionId,
        networkSessionId: input.networkSessionId,
        appAddress: input.appAddress,
        amountMinor: input.amountMinor,
        currency: input.currency,
        paymentRequest,
        metadata: {
          ...(input.metadata ?? {}),
          ...(paymentRequest ? { fiberInvoice: paymentRequest } : {})
        }
      });

      return {
        provider: result.provider,
        network: result.network,
        proofId: result.proofId,
        proofType: 'fiber_payment',
        paymentRequestHash: paymentRequest ? hashFiberPaymentRequest(paymentRequest) : undefined,
        raw: result.raw
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const message = error instanceof Error ? error.message : 'Fiber payment failed.';
      throw new ApiError(502, 'FIBER_PAYMENT_FAILED', message);
    }
  }

  async getNodeStatus(sessionId = 'node_info') {
    return this.provider.getStatus(sessionId);
  }
}

export const fiberAdapter = new FiberAdapter();
