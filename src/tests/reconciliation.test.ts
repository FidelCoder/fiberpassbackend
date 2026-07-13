import assert from 'node:assert/strict';
import { ApiError } from '../lib/errors.js';
import { assertReconciliationResult } from '../services/reconciliation.service.js';

const result = assertReconciliationResult({
  checkedWallets: 1,
  walletsReconciled: 1,
  sessionsExpired: 0,
  attemptsReleased: 0,
  jobsRequeued: 0,
  invoicesRequeued: 0
});
assert.equal(result.walletsReconciled, 1);
assert.throws(
  () => assertReconciliationResult({
    checkedWallets: 1,
    walletsReconciled: -1,
    sessionsExpired: 0,
    attemptsReleased: 0,
    jobsRequeued: 0,
    invoicesRequeued: 0
  }),
  (error: unknown) => error instanceof ApiError && error.code === 'RECONCILIATION_INVALID_RESULT'
);
