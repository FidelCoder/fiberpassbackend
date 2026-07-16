import { ApiError } from '../lib/errors.js';
import { fromMinorUnits, fallbackMinorUnits, clampMinorUnits } from '../lib/money.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { InvoiceModel, PaymentJobModel } from '../models/automation.model.js';
import { SessionModel, type SessionRecord, type SessionStatus } from '../models/session.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { writeAuditLog } from './audit.service.js';
import { releaseChargeReservation } from './chargeReservation.service.js';
import { CREATE_SESSION_POLICY, reconcileWalletBalanceWithCurrentVault } from './session.service.js';

export interface ReconciliationWorkerOptions {
  limit?: number;
  staleAttemptMs?: number;
  staleJobMs?: number;
  workerId?: string;
}

export interface ReconciliationWorkerResult {
  checkedWallets: number;
  walletsReconciled: number;
  sessionsExpired: number;
  attemptsReleased: number;
  jobsRequeued: number;
  invoicesRequeued: number;
}

const OPEN_STATUSES: SessionStatus[] = ['active', 'paused'];
const DEFAULT_STALE_ATTEMPT_MS = 10 * 60 * 1000;
const DEFAULT_STALE_JOB_MS = 10 * 60 * 1000;

function sessionSpentMinor(session: { spent?: number | null; spentMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(session.spentMinor, session.spent, session.currency ?? CREATE_SESSION_POLICY.currency);
}

function sessionLimitMinor(session: { limit?: number | null; limitMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(session.limitMinor, session.limit, session.currency ?? CREATE_SESSION_POLICY.currency);
}

function prependLog(session: { logs?: unknown[]; set: (path: string, value: unknown) => void }, type: string, amountMinor = 0, currency: string = CREATE_SESSION_POLICY.currency): void {
  const currentLogs = Array.isArray(session.logs) ? session.logs : [];
  session.set('logs', [{
    id: 'log_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    type,
    timestamp: new Date().toISOString().slice(11, 19) + ' UTC',
    amount: fromMinorUnits(amountMinor, currency),
    amountMinor
  }, ...currentLogs]);
}

async function expireDueSessions(limit: number): Promise<number> {
  const now = new Date();
  const sessions = await SessionModel.find({
    status: { $in: OPEN_STATUSES },
    expiryAt: { $lte: now }
  }).sort({ expiryAt: 1 }).limit(limit);

  let expired = 0;
  for (const session of sessions) {
    const object = session.toObject() as SessionRecord;
    const remainingMinor = clampMinorUnits(sessionLimitMinor(object) - sessionSpentMinor(object));
    session.status = 'expired';
    session.fiberStatus = 'expired';
    session.expiryTime = 'Expired by reconciliation';
    prependLog(session, 'Session Expired - Reserve Released', remainingMinor, session.currency);
    await session.save();
    await reconcileWalletBalanceWithCurrentVault(session.ownerWalletId as string);
    await writeAuditLog({
      actorWalletId: session.ownerWalletId as string,
      action: 'reconciliation.session_expired',
      targetType: 'session',
      targetId: session.publicId,
      metadata: { remainingMinor }
    });
    expired += 1;
  }
  return expired;
}

async function releaseStaleChargeAttempts(staleBefore: Date, limit: number): Promise<number> {
  const attempts = await ChargeAttemptModel.find({
    status: 'pending',
    reserveStatus: 'reserved',
    providerStatus: 'not_started',
    executionLeaseExpiresAt: { $lte: staleBefore }
  }).sort({ createdAt: 1 }).limit(limit);

  let released = 0;
  for (const attempt of attempts) {
    await releaseChargeReservation(
      attempt.attemptId,
      'STALE_CHARGE_ATTEMPT',
      'Charge attempt lease expired before provider submission.'
    );
    await writeAuditLog({
      actorWalletId: attempt.ownerWalletId ?? undefined,
      action: 'reconciliation.charge_attempt_released',
      targetType: 'charge_attempt',
      targetId: attempt.attemptId,
      metadata: { sessionId: attempt.sessionId, appId: attempt.appId }
    });
    released += 1;
  }
  return released;
}

async function requeueStalePaymentJobs(staleBefore: Date, limit: number): Promise<{ jobsRequeued: number; invoicesRequeued: number }> {
  const jobs = await PaymentJobModel.find({
    status: { $in: ['locked', 'processing'] },
    $or: [
      { lockedAt: { $lte: staleBefore } },
      { startedAt: { $lte: staleBefore } }
    ]
  }).sort({ lockedAt: 1, startedAt: 1 }).limit(limit);

  let jobsRequeued = 0;
  let invoicesRequeued = 0;
  for (const job of jobs) {
    const now = new Date();
    job.status = job.attempts >= job.maxAttempts ? 'failed' : 'retrying';
    job.runAfter = now;
    job.lastFailureCode = 'STALE_PAYMENT_JOB';
    job.lastFailureMessage = 'Payment worker lock timed out before completion.';
    job.set('lockedAt', undefined);
    job.set('lockedBy', undefined);
    if (job.status === 'failed') job.failedAt = now;
    await job.save();

    const invoice = await InvoiceModel.findOne({ invoiceId: job.invoiceId, appId: job.appId, ownerWalletId: job.ownerWalletId });
    if (invoice && invoice.status === 'processing') {
      invoice.status = job.status === 'failed' ? 'failed' : 'queued';
      invoice.lastFailureCode = job.lastFailureCode;
      invoice.lastFailureMessage = job.lastFailureMessage;
      if (job.status === 'failed') invoice.failedAt = now;
      await invoice.save();
      invoicesRequeued += 1;
    }

    await writeAuditLog({
      actorWalletId: job.ownerWalletId,
      action: 'reconciliation.payment_job_requeued',
      targetType: 'payment_job',
      targetId: job.jobId,
      metadata: { invoiceId: job.invoiceId, sessionId: job.sessionId, nextStatus: job.status }
    });
    jobsRequeued += 1;
  }

  return { jobsRequeued, invoicesRequeued };
}

async function reconcileWallets(limit: number): Promise<{ checkedWallets: number; walletsReconciled: number }> {
  const wallets = await WalletModel.find({}).select('walletId').sort({ updatedAt: -1 }).limit(limit).lean<Array<{ walletId: string }>>();
  let walletsReconciled = 0;
  for (const wallet of wallets) {
    await reconcileWalletBalanceWithCurrentVault(wallet.walletId);
    walletsReconciled += 1;
  }
  return { checkedWallets: wallets.length, walletsReconciled };
}

export async function runReconciliationWorkerOnce(options: ReconciliationWorkerOptions = {}): Promise<ReconciliationWorkerResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const staleAttemptMs = Math.max(60_000, options.staleAttemptMs ?? DEFAULT_STALE_ATTEMPT_MS);
  const staleJobMs = Math.max(60_000, options.staleJobMs ?? DEFAULT_STALE_JOB_MS);
  const [sessionsExpired, attemptsReleased, jobResult, walletResult] = await Promise.all([
    expireDueSessions(limit),
    releaseStaleChargeAttempts(new Date(Date.now() - staleAttemptMs), limit),
    requeueStalePaymentJobs(new Date(Date.now() - staleJobMs), limit),
    reconcileWallets(limit)
  ]);

  return {
    checkedWallets: walletResult.checkedWallets,
    walletsReconciled: walletResult.walletsReconciled,
    sessionsExpired,
    attemptsReleased,
    jobsRequeued: jobResult.jobsRequeued,
    invoicesRequeued: jobResult.invoicesRequeued
  };
}

export function assertReconciliationResult(result: ReconciliationWorkerResult): ReconciliationWorkerResult {
  if (Object.values(result).some((value) => !Number.isFinite(value) || value < 0)) {
    throw new ApiError(500, 'RECONCILIATION_INVALID_RESULT', 'Reconciliation worker returned invalid counters.');
  }
  return result;
}
