import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { ChargeDailyCounterModel } from '../models/chargeDailyCounter.model.js';
import { SessionModel } from '../models/session.model.js';
import {
  ChargeReservationError,
  finalizeChargeReservation,
  markChargeOutcomeUncertain,
  markChargeProviderSubmitted,
  markChargeProviderSucceeded,
  reserveChargeAttempt
} from '../services/chargeReservation.service.js';

const uri = process.env.CHARGE_RESERVATION_TEST_MONGODB_URI;
if (!uri) {
  throw new Error('CHARGE_RESERVATION_TEST_MONGODB_URI is required for reservation integration tests.');
}

const dbName = 'fiberpass_charge_reservation_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });

async function createSession(publicId: string, limitMinor: number, singleUse = false): Promise<void> {
  await SessionModel.create({
    ownerWalletId: 'wallet-integration',
    publicId,
    name: 'Atomic reservation test',
    serviceAddress: 'ckt1-integration',
    paymentPurpose: 'app_session',
    spent: 0,
    spentMinor: 0,
    reservedMinor: 0,
    limit: limitMinor / 100_000_000,
    limitMinor,
    currency: 'CKB',
    duration: 'test',
    status: 'active',
    iconType: 'rpc',
    expiryTime: 'No expiry',
    autoMicroCharges: true,
    singleUse,
    logs: []
  });
}

function reservationInput(sessionId: string, index: number, amountMinor: number, dailyLimitMinor: number) {
  return {
    attemptId: 'attempt-' + sessionId + '-' + index,
    sessionId,
    ownerWalletId: 'wallet-integration',
    idempotencyKey: 'key-' + index,
    requestFingerprint: 'fingerprint-' + index,
    amount: amountMinor / 100_000_000,
    amountMinor,
    currency: 'CKB',
    type: 'Contention test',
    executionLayer: 'fiber' as const,
    providerCorrelationId: '0x' + index.toString(16).padStart(64, '0'),
    dailyLimitMinor,
    executionLeaseId: 'lease-' + index
  };
}

try {
  await Promise.all([
    SessionModel.syncIndexes(),
    ChargeAttemptModel.syncIndexes(),
    ChargeDailyCounterModel.syncIndexes()
  ]);

  await createSession('fp_pass_contention', 100_000_000);
  const contention = await Promise.allSettled(
    Array.from({ length: 40 }, (_, index) => reserveChargeAttempt(
      reservationInput('fp_pass_contention', index, 10_000_000, 1_000_000_000)
    ))
  );
  const accepted = contention.filter((result) => result.status === 'fulfilled');
  const rejected = contention.filter((result) => result.status === 'rejected');
  assert.equal(accepted.length, 10);
  assert.equal(rejected.length, 30);
  assert.ok(rejected.every((result) => (
    result.status === 'rejected'
    && result.reason instanceof ChargeReservationError
    && result.reason.code === 'SESSION_RESERVATION_REJECTED'
  )));
  const contentionSession = await SessionModel.findOne({ publicId: 'fp_pass_contention' }).lean();
  assert.equal(contentionSession?.reservedMinor, 100_000_000);
  assert.equal(contentionSession?.spentMinor, 0);
  assert.equal(await ChargeAttemptModel.countDocuments({ sessionId: 'fp_pass_contention' }), 10);

  await createSession('fp_pass_duplicate', 100_000_000);
  const duplicateInput = reservationInput('fp_pass_duplicate', 1, 10_000_000, 100_000_000);
  const duplicates = await Promise.all(
    Array.from({ length: 20 }, () => reserveChargeAttempt(duplicateInput))
  );
  assert.equal(duplicates.filter((result) => result.created).length, 1);
  assert.equal(await ChargeAttemptModel.countDocuments({ sessionId: 'fp_pass_duplicate' }), 1);
  const duplicateSession = await SessionModel.findOne({ publicId: 'fp_pass_duplicate' }).lean();
  assert.equal(duplicateSession?.reservedMinor, 10_000_000);

  await createSession('fp_pass_daily', 1_000_000_000);
  const daily = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) => reserveChargeAttempt(
      reservationInput('fp_pass_daily', index, 10_000_000, 30_000_000)
    ))
  );
  assert.equal(daily.filter((result) => result.status === 'fulfilled').length, 3);
  const dailyCounter = await ChargeDailyCounterModel.findOne({ sessionId: 'fp_pass_daily' }).lean();
  assert.equal(dailyCounter?.reservedMinor, 30_000_000);

  await createSession('fp_pass_single_use', 100_000_000, true);
  const singleUse = await Promise.allSettled(
    Array.from({ length: 10 }, (_, index) => reserveChargeAttempt(
      reservationInput('fp_pass_single_use', index, 10_000_000, 100_000_000)
    ))
  );
  assert.equal(singleUse.filter((result) => result.status === 'fulfilled').length, 1);
  const singleUseSession = await SessionModel.findOne({ publicId: 'fp_pass_single_use' }).lean();
  assert.equal(singleUseSession?.reservedMinor, 10_000_000);

  const finalizable = duplicates[0].attempt;
  await markChargeProviderSubmitted(finalizable.attemptId, duplicateInput.executionLeaseId);
  await markChargeProviderSucceeded(finalizable.attemptId, {
    provider: 'rpc',
    network: 'testnet',
    proofId: duplicateInput.providerCorrelationId,
    proofType: 'fiber_payment',
    executionLayer: 'fiber'
  });
  await finalizeChargeReservation(finalizable.attemptId);
  await finalizeChargeReservation(finalizable.attemptId);
  const finalizedSession = await SessionModel.findOne({ publicId: 'fp_pass_duplicate' }).lean();
  assert.equal(finalizedSession?.reservedMinor, 0);
  assert.equal(finalizedSession?.spentMinor, 10_000_000);
  assert.equal(await ChargeAttemptModel.countDocuments({ attemptId: finalizable.attemptId, status: 'succeeded' }), 1);

  const uncertainAttempt = accepted[0].status === 'fulfilled' ? accepted[0].value.attempt : undefined;
  assert.ok(uncertainAttempt);
  await markChargeProviderSubmitted(uncertainAttempt.attemptId, 'lease-0');
  await markChargeOutcomeUncertain(uncertainAttempt.attemptId, 'TEST_CRASH', 'Simulated crash after provider submission.');
  const uncertain = await ChargeAttemptModel.findOne({ attemptId: uncertainAttempt.attemptId }).lean();
  assert.equal(uncertain?.status, 'uncertain');
  assert.equal(uncertain?.reserveStatus, 'reserved');
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
