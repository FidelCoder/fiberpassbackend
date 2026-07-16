import { createHash } from 'node:crypto';
import { ApiError } from '../lib/errors.js';
import { fiberProvider, type FiberInvoiceCurrency, type FiberParsedInvoice, type FiberPaymentStatusResult, type FiberProvider, type FiberProviderKind } from './fiberProvider.js';

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

export interface FiberPreparedPayment {
  paymentRequest?: string;
  paymentRequestHash?: string;
  providerCorrelationId?: string;
  invoice?: FiberParsedInvoice;
}

function expectedInvoiceCurrency(network: string): FiberInvoiceCurrency {
  const normalized = network.trim().toLowerCase();
  if (normalized.includes('main')) return 'Fibb';
  if (normalized.includes('dev')) return 'Fibd';
  return 'Fibt';
}

export function validateFiberInvoiceForPayment(input: {
  invoice: FiberParsedInvoice;
  amountMinor: number;
  currency: string;
  network: string;
  nowSeconds?: number;
}): void {
  if (input.currency.toUpperCase() !== 'CKB' || input.invoice.hasUdtScript) {
    throw new ApiError(400, 'FIBER_INVOICE_CURRENCY_MISMATCH', 'Fiber invoice must request native CKB.');
  }
  if (input.invoice.currency !== expectedInvoiceCurrency(input.network)) {
    throw new ApiError(400, 'FIBER_INVOICE_NETWORK_MISMATCH', 'Fiber invoice belongs to a different network.');
  }
  if (input.invoice.amountMinor == null) {
    throw new ApiError(400, 'FIBER_INVOICE_AMOUNT_REQUIRED', 'Fiber invoice must encode an exact amount.');
  }
  if (input.invoice.amountMinor !== input.amountMinor) {
    throw new ApiError(400, 'FIBER_INVOICE_AMOUNT_MISMATCH', 'Fiber invoice amount does not match the FiberPass debit.');
  }
  if (!input.invoice.signed) {
    throw new ApiError(400, 'FIBER_INVOICE_UNSIGNED', 'Fiber invoice must be signed by its payee.');
  }
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (input.invoice.expiresAtSeconds != null && input.invoice.expiresAtSeconds <= nowSeconds) {
    throw new ApiError(410, 'FIBER_INVOICE_EXPIRED', 'Fiber invoice has expired.');
  }
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

  async preparePayment(input: FiberPaymentExecutionInput): Promise<FiberPreparedPayment> {
    const keysendTargetPubkey = typeof input.metadata?.fiberKeysendTargetPubkey === 'string'
      ? input.metadata.fiberKeysendTargetPubkey.trim()
      : '';
    const paymentRequest = keysendTargetPubkey ? undefined : normalizeFiberPaymentRequest(input.paymentRequest);
    try {
      const invoice = paymentRequest
        ? await this.provider.parseInvoice(paymentRequest)
        : undefined;
      if (invoice) {
        validateFiberInvoiceForPayment({
          invoice,
          amountMinor: input.amountMinor,
          currency: input.currency,
          network: this.provider.network
        });
      }
      return {
        paymentRequest,
        paymentRequestHash: paymentRequest ? hashFiberPaymentRequest(paymentRequest) : undefined,
        providerCorrelationId: invoice?.paymentHash,
        invoice
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const message = error instanceof Error ? error.message : 'Fiber payment preparation failed.';
      const code = /parse_invoice|invoice/i.test(message) ? 'FIBER_INVOICE_PARSE_FAILED' : 'FIBER_PAYMENT_FAILED';
      throw new ApiError(502, code, message);
    }
  }

  async executePayment(input: FiberPaymentExecutionInput, prepared?: FiberPreparedPayment): Promise<FiberPaymentExecutionResult> {
    try {
      const payment = prepared ?? await this.preparePayment(input);
      const paymentRequest = payment.paymentRequest;
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

      if (!/^0x[0-9a-fA-F]{64}$/.test(result.proofId)) {
        throw new ApiError(502, 'FIBER_PAYMENT_PROOF_MISSING', 'Fiber payment succeeded without a valid payment hash proof.');
      }
      if (payment.invoice && result.proofId.toLowerCase() !== payment.invoice.paymentHash) {
        throw new ApiError(502, 'FIBER_PAYMENT_PROOF_MISMATCH', 'Fiber payment proof does not match the requested invoice.');
      }

      return {
        provider: result.provider,
        network: result.network,
        proofId: result.proofId,
        proofType: 'fiber_payment',
        paymentRequestHash: payment.paymentRequestHash,
        raw: result.raw
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const message = error instanceof Error ? error.message : 'Fiber payment failed.';
      const code = /parse_invoice|invoice/i.test(message) ? 'FIBER_INVOICE_PARSE_FAILED' : 'FIBER_PAYMENT_FAILED';
      throw new ApiError(502, code, message);
    }
  }

  async reconcilePayment(providerCorrelationId: string): Promise<FiberPaymentStatusResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(providerCorrelationId)) {
      throw new ApiError(409, 'CHARGE_RECONCILIATION_REQUIRED', 'This payment does not have a queryable Fiber payment hash.');
    }
    try {
      return await this.provider.getPayment(providerCorrelationId.toLowerCase());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'FIBER_PAYMENT_RECONCILIATION_FAILED', error instanceof Error ? error.message : 'Fiber payment reconciliation failed.');
    }
  }

  async getNodeStatus(sessionId = 'node_info') {
    return this.provider.getStatus(sessionId);
  }
}

export const fiberAdapter = new FiberAdapter();
