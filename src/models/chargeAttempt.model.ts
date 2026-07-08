import { Schema, model, type InferSchemaType } from 'mongoose';

export const CHARGE_ATTEMPT_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type ChargeAttemptStatus = (typeof CHARGE_ATTEMPT_STATUSES)[number];

const chargeAttemptSchema = new Schema(
  {
    attemptId: { type: String, required: true, unique: true, index: true },
    sessionId: { type: String, required: true, index: true },
    appId: { type: String, index: true },
    apiKeyId: { type: String, index: true },
    ownerWalletId: { type: String, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'USDC' },
    type: { type: String, required: true, trim: true },
    status: { type: String, enum: CHARGE_ATTEMPT_STATUSES, required: true, default: 'pending', index: true },
    failureCode: { type: String, trim: true },
    failureMessage: { type: String, trim: true },
    resultingSpent: { type: Number, min: 0 },
    remainingBalance: { type: Number, min: 0 },
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

export type ChargeAttemptRecord = InferSchemaType<typeof chargeAttemptSchema>;
export const ChargeAttemptModel = model('ChargeAttempt', chargeAttemptSchema);
