import assert from 'node:assert/strict';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { FiberAdapter, hashFiberPaymentRequest, normalizeFiberPaymentRequest, validateFiberInvoiceForPayment } from '../services/fiberAdapter.js';
import { parseFiberInvoiceRpcResult, type FiberProvider, type FiberAuthorizeChargeInput, type FiberParsedInvoice } from '../services/fiberProvider.js';

let capturedCharge: FiberAuthorizeChargeInput | undefined;
const provider: FiberProvider = {
  kind: 'rpc',
  network: 'testnet',
  async createSession() {
    throw new Error('not used');
  },
  async parseInvoice() {
    return {
      amountMinor: 2_000_000,
      currency: 'Fibt',
      paymentHash: '0x' + '22'.repeat(32),
      createdAtSeconds: Math.floor(Date.now() / 1000),
      expiresAtSeconds: Math.floor(Date.now() / 1000) + 3600,
      hasUdtScript: false,
      signed: true
    };
  },
  async getPayment(paymentHash) {
    return {
      provider: 'rpc',
      network: 'testnet',
      paymentHash,
      status: 'Success'
    };
  },
  async authorizeCharge(input) {
    capturedCharge = input;
    return {
      provider: 'rpc',
      network: 'testnet',
      authorized: true,
      proofId: '0x' + '22'.repeat(32),
      status: 'Success',
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
assert.equal(result.proofId, '0x' + '22'.repeat(32));
assert.equal(result.proofType, 'fiber_payment');
assert.equal(result.paymentRequestHash, hashFiberPaymentRequest(paymentRequest));
assert.equal(capturedCharge?.paymentRequest, paymentRequest);

const preparedPayment = await adapter.preparePayment({
  sessionId: 'fp_pass_1',
  appAddress: 'ckt1app',
  amountMinor: 2_000_000,
  currency: 'CKB',
  paymentRequest
});
assert.equal(preparedPayment.providerCorrelationId, '0x' + '22'.repeat(32));
assert.equal(preparedPayment.paymentRequestHash, hashFiberPaymentRequest(paymentRequest));
const reconciledPayment = await adapter.reconcilePayment(preparedPayment.providerCorrelationId ?? '');
assert.equal(reconciledPayment.status, 'Success');
assert.equal(reconciledPayment.paymentHash, preparedPayment.providerCorrelationId);

for (const [expectedCode, proofId] of [
  ['FIBER_PAYMENT_PROOF_MISSING', ''],
  ['FIBER_PAYMENT_PROOF_MISMATCH', '0x' + '99'.repeat(32)]
] as const) {
  const invalidProofProvider: FiberProvider = {
    ...provider,
    async authorizeCharge(input) {
      capturedCharge = input;
      return {
        provider: 'rpc',
        network: 'testnet',
        authorized: true,
        proofId,
        status: 'Success'
      };
    }
  };
  await assert.rejects(
    () => new FiberAdapter(invalidProofProvider).executePayment({
      sessionId: 'session-proof-test',
      appAddress: 'ckt1-app-proof-test',
      amountMinor: 2_000_000,
      currency: 'CKB',
      paymentRequest
    }),
    (error: unknown) => (error as { code?: string }).code === expectedCode
  );
}
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
    fields.sessionId === 1
    && fields.idempotencyKey === 1
    && options?.unique === true
  );
}));

const nowSeconds = 1_750_000_000;
const validInvoice: FiberParsedInvoice = {
  amountMinor: 2_000_000,
  currency: 'Fibt',
  paymentHash: '0x' + '33'.repeat(32),
  createdAtSeconds: nowSeconds - 60,
  expiresAtSeconds: nowSeconds + 60,
  hasUdtScript: false,
  signed: true
};

assert.doesNotThrow(() => validateFiberInvoiceForPayment({
  invoice: validInvoice,
  amountMinor: 2_000_000,
  currency: 'CKB',
  network: 'testnet',
  nowSeconds
}));

for (const [expectedCode, invoice, overrides] of [
  ['FIBER_INVOICE_AMOUNT_REQUIRED', { ...validInvoice, amountMinor: undefined }, {}],
  ['FIBER_INVOICE_AMOUNT_MISMATCH', { ...validInvoice, amountMinor: 2_000_001 }, {}],
  ['FIBER_INVOICE_NETWORK_MISMATCH', { ...validInvoice, currency: 'Fibb' as const }, {}],
  ['FIBER_INVOICE_CURRENCY_MISMATCH', { ...validInvoice, hasUdtScript: true }, {}],
  ['FIBER_INVOICE_UNSIGNED', { ...validInvoice, signed: false }, {}],
  ['FIBER_INVOICE_EXPIRED', { ...validInvoice, expiresAtSeconds: nowSeconds }, {}]
] as const) {
  assert.throws(
    () => validateFiberInvoiceForPayment({
      invoice,
      amountMinor: 2_000_000,
      currency: 'CKB',
      network: 'testnet',
      nowSeconds,
      ...overrides
    }),
    (error: unknown) => (error as { code?: string }).code === expectedCode
  );
}

const parsedInvoice = parseFiberInvoiceRpcResult({
  invoice: {
    currency: 'Fibt',
    amount: '0x1e8480',
    signature: 'signed-invoice',
    data: {
      timestamp: '0x682f2f00',
      payment_hash: '0x' + '44'.repeat(32),
      attrs: [
        { expiry_time: '0xe10' },
        { payee_public_key: '02' + '55'.repeat(32) }
      ]
    }
  }
});
assert.equal(parsedInvoice.amountMinor, 2_000_000);
assert.equal(parsedInvoice.currency, 'Fibt');
assert.equal(parsedInvoice.paymentHash, '0x' + '44'.repeat(32));
assert.equal(parsedInvoice.expiresAtSeconds, Number(0x682f2f00n + 0xe10n));
assert.equal(parsedInvoice.signed, true);
assert.equal(parsedInvoice.hasUdtScript, false);
assert.throws(
  () => parseFiberInvoiceRpcResult({ invoice: { currency: 'Fibt', amount: '0x1', signature: 'sig', data: { timestamp: '0x1', payment_hash: 'bad', attrs: [] } } }),
  /payment hash/
);
