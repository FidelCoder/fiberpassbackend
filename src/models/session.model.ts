import { Schema, model, type InferSchemaType } from 'mongoose';

export const SESSION_STATUSES = ['active', 'paused', 'settled', 'revoked', 'expired'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ICON_TYPES = ['cloud', 'code', 'database', 'cpu', 'ai', 'video', 'rpc'] as const;
export type IconType = (typeof ICON_TYPES)[number];

const transactionLogSchema = new Schema(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    timestamp: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, min: 0 }
  },
  { _id: false }
);

const sessionSchema = new Schema(
  {
    ownerWalletId: { type: String, required: true, index: true },
    publicId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    serviceAddress: { type: String, required: true, trim: true },
    appId: { type: String, trim: true },
    appUrl: { type: String, trim: true },
    appTrustLevel: { type: String, trim: true },
    appPermissions: { type: [String], default: [] },
    chargePolicy: { type: String, trim: true },
    expiryAt: { type: Date },
    platformFeeEstimate: { type: Number, min: 0, default: 0 },
    platformFeeEstimateMinor: { type: Number, min: 0, default: 0 },
    networkFeeEstimate: { type: Number, min: 0, default: 0 },
    networkFeeEstimateMinor: { type: Number, min: 0, default: 0 },
    spent: { type: Number, required: true, min: 0, default: 0 },
    spentMinor: { type: Number, min: 0, default: 0 },
    limit: { type: Number, required: true, min: 0.01 },
    limitMinor: { type: Number, min: 1 },
    currency: { type: String, required: true, default: 'CKB' },
    duration: { type: String, required: true },
    status: { type: String, enum: SESSION_STATUSES, required: true, default: 'active', index: true },
    iconType: { type: String, enum: ICON_TYPES, required: true, default: 'rpc' },
    expiryTime: { type: String, required: true },
    fiberProvider: { type: String, trim: true },
    fiberNetwork: { type: String, trim: true },
    fiberSessionId: { type: String, trim: true, index: true },
    fiberStatus: { type: String, trim: true, default: 'pending' },
    fiberProofId: { type: String, trim: true },
    lastChargeProofId: { type: String, trim: true },
    autoMicroCharges: { type: Boolean, required: true, default: true },
    singleUse: { type: Boolean, required: true, default: false },
    logs: { type: [transactionLogSchema], default: [] }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

sessionSchema.index({ ownerWalletId: 1, status: 1, createdAt: -1 });
sessionSchema.index({ status: 1, createdAt: -1 });

export type SessionRecord = InferSchemaType<typeof sessionSchema>;
export const SessionModel = model('Session', sessionSchema);
