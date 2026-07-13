import assert from 'node:assert/strict';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { FiberAdapter, hashFiberPaymentRequest, normalizeFiberPaymentRequest } from '../services/fiberAdapter.js';
import type { FiberProvider, FiberAuthorizeChargeInput } from '../services/fiberProvider.js';

let capturedCharge: FiberAuthorizeChargeInput | undefined;
const provider: FiberProvider = {
  kind: 'rpc',
  network: 'testnet',
  async createSession() {
    throw new Error('not used');
  },
  async authorizeCharge(input) {
    capturedCharge = input;
    return {
      provider: 'rpc',
      network: 'testnet',
      authorized: true,
      proofId: 'fiber-proof-1',
      raw: { ok: true }
    };
  },
  async topUpSession() {
    throw new Error('not used');
  },
  async revokeSession() {
    throw new Error('not used');
  },
  async settleSession() {
    throw new Error('not used');
  },
  async getStatus(sessionId) {
    return { provider: 'rpc', network: 'testnet', status: 'pending', networkSessionId: sessionId };
  }
};

const adapter = new FiberAdapter(provider);
const paymentRequest = 'fiber-payment-request-12345';
const result = await adapter.executePayment({
  sessionId: 'fp_pass_1',
  networkSessionId: 'fiber-channel-1',
  appAddress: 'ckt1app',
  amountMinor: 2_000_000,
  currency: 'CKB',
  paymentRequest,
  metadata: { requestId: 'req-1' }
});

assert.equal(result.provider, 'rpc');
assert.equal(result.network, 'testnet');
assert.equal(result.proofId, 'fiber-proof-1');
assert.equal(result.proofType, 'fiber_payment');
assert.equal(result.paymentRequestHash, hashFiberPaymentRequest(paymentRequest));
assert.equal(capturedCharge?.paymentRequest, paymentRequest);
assert.equal(capturedCharge?.metadata?.fiberInvoice, paymentRequest);
assert.equal(normalizeFiberPaymentRequest('  ' + paymentRequest + '  '), paymentRequest);
await assert.rejects(
  () => adapter.executePayment({
    sessionId: 'fp_pass_1',
    appAddress: 'ckt1app',
    amountMinor: 1,
    currency: 'CKB'
  }),
  (error: unknown) => (error as { code?: string }).code === 'FIBER_INVOICE_REQUIRED'
);

assert.ok(ChargeAttemptModel.schema.path('idempotencyKey'));
assert.ok(ChargeAttemptModel.schema.path('serviceReference'));
assert.ok(ChargeAttemptModel.schema.path('reserveStatus'));
assert.ok(ChargeAttemptModel.schema.path('executionLayer'));
assert.ok(ChargeAttemptModel.schema.path('paymentRequestHash'));

const indexes = ChargeAttemptModel.schema.indexes();
assert.ok(indexes.some(([fields, options]) => {
  return Boolean(
    fields.appId === 1
    && fields.idempotencyKey === 1
    && options?.unique === true
  );
}));
