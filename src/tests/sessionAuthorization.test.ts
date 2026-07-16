import assert from 'node:assert/strict';
import type { SessionRecord } from '../models/session.model.js';
import {
  assertChargePreflight,
  normalizeSessionAppPermissions,
  type ChargeSessionInput
} from '../services/session.service.js';

const now = new Date();
const baseSession = {
  ownerWalletId: 'wallet-a',
  publicId: 'fp_pass_authorized',
  serviceAddress: 'ckt1-service-a',
  appId: 'fp_app_a',
  appPermissions: ['charges:create'],
  appGrantOwnerWalletId: 'wallet-a',
  appGrantCreatedAt: now,
  paymentPurpose: 'app_session',
  recipientWallets: [],
  status: 'active',
  autoMicroCharges: true
} as unknown as SessionRecord;

const directAppCharge: ChargeSessionInput = {
  sessionId: 'fp_pass_authorized',
  amount: 1,
  type: 'API charge',
  appId: 'fp_app_a',
  apiKeyId: 'fp_key_a',
  appOwnerWalletId: 'wallet-a',
  appServiceAddress: 'CKT1-SERVICE-A',
  chargeOrigin: 'app_api_key'
};

function expectCode(code: string, session: SessionRecord, request: ChargeSessionInput = directAppCharge): void {
  assert.throws(
    () => assertChargePreflight(session, request, 100_000_000),
    (error: unknown) => (error as { code?: string }).code === code
  );
}

assert.doesNotThrow(() => assertChargePreflight(baseSession, directAppCharge, 100_000_000));

expectCode('APP_AUTH_CONTEXT_REQUIRED', baseSession, {
  ...directAppCharge,
  appOwnerWalletId: undefined
});
expectCode('APP_OWNER_MISMATCH', baseSession, {
  ...directAppCharge,
  appOwnerWalletId: 'wallet-b',
  appServiceAddress: baseSession.serviceAddress
});
expectCode('APP_SESSION_GRANT_REQUIRED', {
  ...baseSession,
  appId: 'manual',
  appGrantOwnerWalletId: undefined,
  appGrantCreatedAt: undefined
} as SessionRecord);
expectCode('APP_GRANT_OWNER_MISMATCH', {
  ...baseSession,
  appGrantOwnerWalletId: 'wallet-b'
} as SessionRecord);
expectCode('APP_SESSION_MISMATCH', { ...baseSession, appId: 'fp_app_b' } as SessionRecord);
expectCode('APP_SERVICE_ADDRESS_MISMATCH', {
  ...baseSession,
  serviceAddress: 'ckt1-service-b'
} as SessionRecord);
expectCode('APP_CHARGES_DISABLED', { ...baseSession, autoMicroCharges: false } as SessionRecord);
expectCode('APP_SESSION_PERMISSION_REQUIRED', { ...baseSession, appPermissions: [] } as SessionRecord);
expectCode('SESSION_NOT_CHARGEABLE', { ...baseSession, status: 'paused' } as SessionRecord);

const referencedSession = { ...baseSession, paymentReference: 'subscription-42' } as SessionRecord;
expectCode('PAYMENT_REFERENCE_REQUIRED', referencedSession);
expectCode('PAYMENT_REFERENCE_MISMATCH', referencedSession, {
  ...directAppCharge,
  serviceReference: 'subscription-43'
});
assert.doesNotThrow(() => assertChargePreflight(referencedSession, {
  ...directAppCharge,
  serviceReference: 'subscription-42'
}, 100_000_000));
assert.doesNotThrow(() => assertChargePreflight(referencedSession, {
  ...directAppCharge,
  metadata: { paymentReference: 'subscription-42' }
}, 100_000_000));

assert.deepEqual(normalizeSessionAppPermissions([
  'Spend from this pass within its rule',
  'charges:create',
  'charges:create'
]), ['charges:create']);
assert.deepEqual(normalizeSessionAppPermissions(['legacy descriptive permission']), []);
assert.deepEqual(normalizeSessionAppPermissions(undefined, true), ['charges:create']);

assert.doesNotThrow(() => assertChargePreflight({
  ...baseSession,
  autoMicroCharges: false,
  appPermissions: []
} as SessionRecord, {
  sessionId: baseSession.publicId,
  amount: 1,
  type: 'Scheduled payout',
  chargeOrigin: 'system'
}, 100_000_000));
