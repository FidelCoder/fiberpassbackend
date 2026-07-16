import assert from 'node:assert/strict';
import { ChargeAttemptModel, CHARGE_ATTEMPT_STATUSES, CHARGE_PROVIDER_STATUSES } from '../models/chargeAttempt.model.js';
import { ChargeDailyCounterModel } from '../models/chargeDailyCounter.model.js';
import { SessionModel } from '../models/session.model.js';
import {
  chargeReservationDay,
  dailyReservationExpression,
  sessionReservationExpression
} from '../services/chargeReservation.service.js';
import { chargeRequestFingerprint } from '../services/session.service.js';

assert.equal(chargeReservationDay(new Date('2026-07-16T23:59:59.999Z')), '2026-07-16');
assert.deepEqual(sessionReservationExpression(25), {
  $lte: [
    { $add: [{ $ifNull: ['$spentMinor', 0] }, { $ifNull: ['$reservedMinor', 0] }, 25] },
    { $ifNull: ['$limitMinor', 0] }
  ]
});
assert.deepEqual(dailyReservationExpression(25, 100), {
  $lte: [
    { $add: [{ $ifNull: ['$spentMinor', 0] }, { $ifNull: ['$reservedMinor', 0] }, 25] },
    100
  ]
});

const fingerprintInput = {
  sessionId: 'fp_pass_atomic',
  amountMinor: 100,
  currency: 'CKB',
  appId: 'fp_app_atomic',
  serviceReference: 'invoice-1',
  paymentRequestHash: 'request-hash',
  executionLayer: 'fiber' as const,
  recipientAddress: 'CKT1-RECIPIENT',
  providerTarget: '02AA'
};
assert.equal(chargeRequestFingerprint(fingerprintInput), chargeRequestFingerprint({
  ...fingerprintInput,
  recipientAddress: 'ckt1-recipient'
}));
assert.notEqual(chargeRequestFingerprint(fingerprintInput), chargeRequestFingerprint({
  ...fingerprintInput,
  amountMinor: 101
}));
assert.notEqual(chargeRequestFingerprint(fingerprintInput), chargeRequestFingerprint({
  ...fingerprintInput,
  providerTarget: '02BB'
}));

assert.ok(CHARGE_ATTEMPT_STATUSES.includes('uncertain'));
assert.ok(CHARGE_PROVIDER_STATUSES.includes('submitted'));
assert.ok(CHARGE_PROVIDER_STATUSES.includes('succeeded'));
assert.ok(SessionModel.schema.path('reservedMinor'));
assert.ok(ChargeAttemptModel.schema.path('providerCorrelationId'));
assert.ok(ChargeAttemptModel.schema.path('requestFingerprint'));

const attemptIndexes = ChargeAttemptModel.schema.indexes();
assert.ok(attemptIndexes.some(([fields, options]) => (
  fields.sessionId === 1
  && fields.idempotencyKey === 1
  && options?.unique === true
)));
const dailyIndexes = ChargeDailyCounterModel.schema.indexes();
assert.ok(dailyIndexes.some(([fields, options]) => (
  fields.sessionId === 1
  && fields.day === 1
  && options?.unique === true
)));
