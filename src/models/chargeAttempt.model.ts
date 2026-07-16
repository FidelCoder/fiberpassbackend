import { Schema, model, type InferSchemaType } from 'mongoose';

export const CHARGE_ATTEMPT_STATUSES = ['pending', 'uncertain', 'succeeded', 'failed'] as const;
export type ChargeAttemptStatus = (typeof CHARGE_ATTEMPT_STATUSES)[number];
export const CHARGE_RESERVE_STATUSES = ['reserved', 'debited', 'released'] as const;
export type ChargeReserveStatus = (typeof CHARGE_RESERVE_STATUSES)[number];
export const CHARGE_EXECUTION_LAYERS = ['fiber', 'ckb-vault'] as const;
export type ChargeExecutionLayer = (typeof CHARGE_EXECUTION_LAYERS)[number];
export const CHARGE_PROVIDER_STATUSES = ['not_started', 'submitted', 'uncertain', 'succeeded', 'failed'] as const;
export type ChargeProviderStatus = (typeof CHARGE_PROVIDER_STATUSES)[number];

const chargeAttemptSchema = new Schema(
  {
    attemptId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    appId: { type: String, index: true },
    apiKeyId: { type: String, index: true },
    ownerWalletId: { type: String, index: true },
    idempotencyKey: { type: String, trim: true },
    requestFingerprint: { type: String, trim: true },
    serviceReference: { type: String, trim: true },
    amount: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, min: 0 },
    currency: { type: String, required: true, default: 'CKB' },
    type: { type: String, required: true, trim: true },
    status: { type: String, enum: CHARGE_ATTEMPT_STATUSES, required: true, default: 'pending', index: true },
    reserveStatus: { type: String, enum: CHARGE_RESERVE_STATUSES, required: true, default: 'reserved', index: true },
    failureCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true },
    resultingSpent: { type: Number, min: 0 },
    resultingSpentMinor: { type: Number, min: 0 },
    remainingBalance: { type: Number, min: 0 },
    remainingBalanceMinor: { type: Number, min: 0 },
    provider: { type: String, trim: true },
    network: { type: String, trim: true },
    proofId: { type: String, trim: true },
    proofType: { type: String, trim: true },
    executionLayer: { type: String, enum: CHARGE_EXECUTION_LAYERS, required: true, default: 'fiber' },
    paymentRequestHash: { type: String, trim: true },
    providerCorrelationId: { type: String, trim: true },
    providerStatus: { type: String, enum: CHARGE_PROVIDER_STATUSES, required: true, default: 'not_started', index: true },
    providerSubmittedAt: { type: Date },
    providerCompletedAt: { type: Date },
    reservationDay: { type: String, trim: true },
    reservedAt: { type: Date },
    finalizedAt: { type: Date },
    executionLeaseId: { type: String, trim: true },
    executionLeaseExpiresAt: { type: Date, index: true },
    metadata: { type: Schema.Types.Mixed }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

chargeAttemptSchema.index({ sessionId: 1, createdAt: -1 });
chargeAttemptSchema.index({ appId: 1, createdAt: -1 });
chargeAttemptSchema.index({ ownerWalletId: 1, createdAt: -1 });
chargeAttemptSchema.index(
  { sessionId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: 'string' }
    }
  }
);

export type ChargeAttemptRecord = InferSchemaType<typeof chargeAttemptSchema>;
export const ChargeAttemptModel = model('ChargeAttempt', chargeAttemptSchema);
