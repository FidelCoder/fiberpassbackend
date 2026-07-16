import type { FilterQuery } from 'mongoose';
import { ChargeAttemptModel, type ChargeAttemptRecord } from '../models/chargeAttempt.model.js';
import { ChargeDailyCounterModel } from '../models/chargeDailyCounter.model.js';
import { SessionModel, type SessionRecord } from '../models/session.model.js';

const EXECUTION_LEASE_MS = 60_000;

export type ChargeAttemptLike = ChargeAttemptRecord & { createdAt?: Date };

export class ChargeReservationError extends Error {
  constructor(public readonly code: 'SESSION_RESERVATION_REJECTED' | 'DAILY_RESERVATION_REJECTED', message: string) {
    super(message);
  }
}

export interface ReserveChargeAttemptInput {
  attemptId: string;
  sessionId: string;
  ownerWalletId: string;
  appId?: string;
  apiKeyId?: string;
  idempotencyKey: string;
  requestFingerprint: string;
  serviceReference?: string;
  amount: number;
  amountMinor: number;
  currency: string;
  type: string;
  executionLayer: 'fiber' | 'ckb-vault';
  paymentRequestHash?: string;
  providerCorrelationId?: string;
  metadata?: Record<string, unknown>;
  dailyLimitMinor: number;
  executionLeaseId: string;
  sessionMatch?: FilterQuery<SessionRecord>;
  now?: Date;
}

export interface ReserveChargeAttemptResult {
  attempt: ChargeAttemptLike;
  created: boolean;
}

export function chargeReservationDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function sessionReservationExpression(amountMinor: number): Record<string, unknown> {
  return {
    $lte: [
      {
        $add: [
          { $ifNull: ['$spentMinor', 0] },
          { $ifNull: ['$reservedMinor', 0] },
          amountMinor
        ]
      },
      { $ifNull: ['$limitMinor', 0] }
    ]
  };
}

export function dailyReservationExpression(amountMinor: number, dailyLimitMinor: number): Record<string, unknown> {
  return {
    $lte: [
      {
        $add: [
          { $ifNull: ['$spentMinor', 0] },
          { $ifNull: ['$reservedMinor', 0] },
          amountMinor
        ]
      },
      dailyLimitMinor
    ]
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
}

async function existingAttempt(sessionId: string, idempotencyKey: string): Promise<ChargeAttemptLike | null> {
  return ChargeAttemptModel.findOne({ sessionId, idempotencyKey }).lean<ChargeAttemptLike | null>();
}

export async function reserveChargeAttempt(input: ReserveChargeAttemptInput): Promise<ReserveChargeAttemptResult> {
  const now = input.now ?? new Date();
  const reservationDay = chargeReservationDay(now);
  let outcome: ReserveChargeAttemptResult | undefined;

  try {
    await SessionModel.db.transaction(async (mongoSession) => {
      const existing = await ChargeAttemptModel.findOne({
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey
      }).session(mongoSession).lean<ChargeAttemptLike | null>();
      if (existing) {
        outcome = { attempt: existing, created: false };
        return;
      }

      const existingCounter = await ChargeDailyCounterModel.exists({
        sessionId: input.sessionId,
        day: reservationDay
      }).session(mongoSession);
      let historicalSpentMinor = 0;
      if (!existingCounter) {
        const dayStart = new Date(reservationDay + 'T00:00:00.000Z');
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const [historicalSpend] = await ChargeAttemptModel.aggregate<{ totalMinor?: number }>([
          {
            $match: {
              sessionId: input.sessionId,
              status: 'succeeded',
              createdAt: { $gte: dayStart, $lt: dayEnd }
            }
          },
          {
            $group: {
              _id: null,
              totalMinor: {
                $sum: { $ifNull: ['$amountMinor', { $multiply: ['$amount', 100_000_000] }] }
              }
            }
          }
        ]).session(mongoSession);
        historicalSpentMinor = historicalSpend?.totalMinor ?? 0;
      }

      await ChargeDailyCounterModel.updateOne(
        { sessionId: input.sessionId, day: reservationDay },
        { $setOnInsert: { spentMinor: historicalSpentMinor, reservedMinor: 0 } },
        { upsert: true, session: mongoSession }
      );

      const reservedSession = await SessionModel.findOneAndUpdate(
        {
          publicId: input.sessionId,
          ownerWalletId: input.ownerWalletId,
          status: 'active',
          ...(input.sessionMatch ?? {}),
          $or: [
            { singleUse: { $ne: true } },
            {
              $expr: {
                $eq: [
                  { $add: [{ $ifNull: ['$spentMinor', 0] }, { $ifNull: ['$reservedMinor', 0] }] },
                  0
                ]
              }
            }
          ],
          $expr: sessionReservationExpression(input.amountMinor)
        },
        { $inc: { reservedMinor: input.amountMinor } },
        { new: true, session: mongoSession }
      );
      if (!reservedSession) {
        throw new ChargeReservationError('SESSION_RESERVATION_REJECTED', 'The pass cannot reserve this charge.');
      }

      const reservedDay = await ChargeDailyCounterModel.findOneAndUpdate(
        {
          sessionId: input.sessionId,
          day: reservationDay,
          $expr: dailyReservationExpression(input.amountMinor, input.dailyLimitMinor)
        },
        { $inc: { reservedMinor: input.amountMinor } },
        { new: true, session: mongoSession }
      );
      if (!reservedDay) {
        throw new ChargeReservationError('DAILY_RESERVATION_REJECTED', 'The daily pass limit cannot reserve this charge.');
      }

      const [attempt] = await ChargeAttemptModel.create([{
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        appId: input.appId,
        apiKeyId: input.apiKeyId,
        ownerWalletId: input.ownerWalletId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        serviceReference: input.serviceReference,
        amount: input.amount,
        amountMinor: input.amountMinor,
        currency: input.currency,
        type: input.type,
        status: 'pending',
        reserveStatus: 'reserved',
        executionLayer: input.executionLayer,
        paymentRequestHash: input.paymentRequestHash,
        providerCorrelationId: input.providerCorrelationId,
        providerStatus: 'not_started',
        reservationDay,
        reservedAt: now,
        executionLeaseId: input.executionLeaseId,
        executionLeaseExpiresAt: new Date(now.getTime() + EXECUTION_LEASE_MS),
        metadata: input.metadata
      }], { session: mongoSession });
      outcome = { attempt: attempt.toObject() as ChargeAttemptLike, created: true };
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const existing = await existingAttempt(input.sessionId, input.idempotencyKey);
      if (existing) return { attempt: existing, created: false };
    }
    throw error;
  }

  if (!outcome) {
    throw new Error('Charge reservation transaction completed without an attempt.');
  }
  return outcome;
}

export async function claimChargeExecution(attemptId: string, leaseId: string, now = new Date()): Promise<ChargeAttemptLike | null> {
  return ChargeAttemptModel.findOneAndUpdate(
    {
      attemptId,
      status: 'pending',
      reserveStatus: 'reserved',
      providerStatus: 'not_started',
      executionLeaseExpiresAt: { $lte: now }
    },
    {
      $set: {
        executionLeaseId: leaseId,
        executionLeaseExpiresAt: new Date(now.getTime() + EXECUTION_LEASE_MS)
      }
    },
    { new: true }
  ).lean<ChargeAttemptLike | null>();
}

export async function markChargeProviderSubmitted(attemptId: string, leaseId: string): Promise<ChargeAttemptLike | null> {
  return ChargeAttemptModel.findOneAndUpdate(
    { attemptId, executionLeaseId: leaseId, status: 'pending', reserveStatus: 'reserved', providerStatus: 'not_started' },
    { $set: { providerStatus: 'submitted', providerSubmittedAt: new Date() } },
    { new: true }
  ).lean<ChargeAttemptLike | null>();
}

export async function setChargeProviderCorrelation(input: {
  attemptId: string;
  leaseId: string;
  providerCorrelationId: string;
  paymentRequestHash?: string;
}): Promise<ChargeAttemptLike | null> {
  return ChargeAttemptModel.findOneAndUpdate(
    {
      attemptId: input.attemptId,
      executionLeaseId: input.leaseId,
      status: 'pending',
      reserveStatus: 'reserved',
      providerStatus: 'not_started'
    },
    {
      $set: {
        providerCorrelationId: input.providerCorrelationId,
        ...(input.paymentRequestHash ? { paymentRequestHash: input.paymentRequestHash } : {})
      }
    },
    { new: true }
  ).lean<ChargeAttemptLike | null>();
}

export interface ProviderChargeResult {
  provider: string;
  network: string;
  proofId: string;
  proofType: string;
  executionLayer: 'fiber' | 'ckb-vault';
  paymentRequestHash?: string;
}

export async function markChargeProviderSucceeded(
  attemptId: string,
  result: ProviderChargeResult
): Promise<ChargeAttemptLike | null> {
  return ChargeAttemptModel.findOneAndUpdate(
    { attemptId, status: { $in: ['pending', 'uncertain'] }, reserveStatus: 'reserved' },
    {
      $set: {
        providerStatus: 'succeeded',
        providerCompletedAt: new Date(),
        provider: result.provider,
        network: result.network,
        proofId: result.proofId,
        proofType: result.proofType,
        executionLayer: result.executionLayer,
        ...(result.paymentRequestHash ? { paymentRequestHash: result.paymentRequestHash } : {})
      },
      $unset: { failureCode: 1, failureMessage: 1 }
    },
    { new: true }
  ).lean<ChargeAttemptLike | null>();
}

export async function markChargeOutcomeUncertain(attemptId: string, failureCode: string, failureMessage: string): Promise<void> {
  await ChargeAttemptModel.updateOne(
    { attemptId, status: { $in: ['pending', 'uncertain'] }, reserveStatus: 'reserved' },
    {
      $set: {
        status: 'uncertain',
        providerStatus: 'uncertain',
        failureCode,
        failureMessage
      }
    }
  );
}

export async function releaseChargeReservation(attemptId: string, failureCode: string, failureMessage: string): Promise<void> {
  await SessionModel.db.transaction(async (mongoSession) => {
    const attempt = await ChargeAttemptModel.findOne({ attemptId }).session(mongoSession);
    if (!attempt || attempt.reserveStatus === 'released' || attempt.status === 'failed') return;
    if (attempt.reserveStatus !== 'reserved' || !attempt.reservationDay) {
      throw new Error('Charge reservation cannot be released from state ' + attempt.reserveStatus + '.');
    }

    const [sessionResult, dailyResult] = await Promise.all([
      SessionModel.updateOne(
        { publicId: attempt.sessionId, reservedMinor: { $gte: attempt.amountMinor ?? 0 } },
        { $inc: { reservedMinor: -(attempt.amountMinor ?? 0) } },
        { session: mongoSession }
      ),
      ChargeDailyCounterModel.updateOne(
        { sessionId: attempt.sessionId, day: attempt.reservationDay, reservedMinor: { $gte: attempt.amountMinor ?? 0 } },
        { $inc: { reservedMinor: -(attempt.amountMinor ?? 0) } },
        { session: mongoSession }
      )
    ]);
    if (sessionResult.modifiedCount !== 1 || dailyResult.modifiedCount !== 1) {
      throw new Error('Charge reservation counters could not be released consistently.');
    }

    attempt.status = 'failed';
    attempt.reserveStatus = 'released';
    attempt.providerStatus = 'failed';
    attempt.failureCode = failureCode;
    attempt.failureMessage = failureMessage;
    attempt.executionLeaseExpiresAt = new Date();
    await attempt.save({ session: mongoSession });
  });
}

export async function finalizeChargeReservation(attemptId: string): Promise<ChargeAttemptLike> {
  let finalized: ChargeAttemptLike | undefined;
  await SessionModel.db.transaction(async (mongoSession) => {
    const attempt = await ChargeAttemptModel.findOne({ attemptId }).session(mongoSession);
    if (!attempt) throw new Error('Charge attempt was not found for finalization.');
    if (attempt.status === 'succeeded' && attempt.reserveStatus === 'debited') {
      finalized = attempt.toObject() as ChargeAttemptLike;
      return;
    }
    if (attempt.providerStatus !== 'succeeded' || attempt.reserveStatus !== 'reserved' || !attempt.reservationDay) {
      throw new Error('Charge attempt is not ready for finalization.');
    }

    const amountMinor = attempt.amountMinor ?? 0;
    const [sessionResult, dailyResult] = await Promise.all([
      SessionModel.updateOne(
        { publicId: attempt.sessionId, reservedMinor: { $gte: amountMinor } },
        {
          $inc: {
            reservedMinor: -amountMinor,
            spentMinor: amountMinor,
            spent: attempt.amount
          },
          $set: {
            lastChargeProofId: attempt.proofId,
            fiberProvider: attempt.provider,
            fiberNetwork: attempt.network
          }
        },
        { session: mongoSession }
      ),
      ChargeDailyCounterModel.updateOne(
        { sessionId: attempt.sessionId, day: attempt.reservationDay, reservedMinor: { $gte: amountMinor } },
        { $inc: { reservedMinor: -amountMinor, spentMinor: amountMinor } },
        { session: mongoSession }
      )
    ]);
    if (sessionResult.modifiedCount !== 1 || dailyResult.modifiedCount !== 1) {
      throw new Error('Charge reservation counters could not be finalized consistently.');
    }

    attempt.status = 'succeeded';
    attempt.reserveStatus = 'debited';
    attempt.finalizedAt = new Date();
    attempt.executionLeaseExpiresAt = new Date();
    await attempt.save({ session: mongoSession });
    finalized = attempt.toObject() as ChargeAttemptLike;
  });

  if (!finalized) throw new Error('Charge finalization transaction completed without an attempt.');
  return finalized;
}
