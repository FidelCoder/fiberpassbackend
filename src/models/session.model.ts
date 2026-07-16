import { Schema, model, type InferSchemaType } from 'mongoose';

export const SESSION_STATUSES = ['active', 'paused', 'settled', 'revoked', 'expired'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ICON_TYPES = ['cloud', 'code', 'database', 'cpu', 'ai', 'video', 'rpc'] as const;
export type IconType = (typeof ICON_TYPES)[number];

export const PAYMENT_PURPOSES = ['app_session', 'subscription', 'scheduled_release', 'recurring_release'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const RELEASE_CADENCES = ['none', 'on_demand', 'daily', 'weekly', 'monthly', 'custom'] as const;
export type ReleaseCadence = (typeof RELEASE_CADENCES)[number];

export const SESSION_APP_PERMISSIONS = ['charges:create'] as const;
export type SessionAppPermission = (typeof SESSION_APP_PERMISSIONS)[number];

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

const recipientWalletSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true },
    recipientTimeZone: { type: String, trim: true },
    amount: { type: Number, min: 0 },
    amountMinor: { type: Number, min: 1 },
    fiberInvoice: { type: String, trim: true },
    status: { type: String, enum: ['awaiting_details', 'pending', 'processing', 'paid', 'failed'], default: 'pending' },
    inviteStatus: { type: String, enum: ['not_required', 'pending', 'sent', 'claimed', 'expired', 'send_failed'], default: 'not_required' },
    inviteTokenHash: { type: String, trim: true, index: true },
    inviteTokenExpiresAt: { type: Date },
    inviteSentAt: { type: Date },
    inviteClaimedAt: { type: Date },
    inviteLastFailure: { type: String, trim: true },
    chargeAttemptId: { type: String, trim: true },
    paidAt: { type: Date },
    lastAttemptAt: { type: Date },
    lastFailureCode: { type: String, trim: true },
    lastFailureMessage: { type: String, trim: true },
    payoutProofId: { type: String, trim: true },
    payoutExplorerUrl: { type: String, trim: true },
    fiberLiquidityBridgeTxHash: { type: String, trim: true },
    fiberLiquidityBridgeAmountMinor: { type: Number, min: 1 },
    fiberLiquidityBridgeStatus: { type: String, trim: true },
    fiberLiquidityBridgeCreatedAt: { type: Date },
    fiberLiquidityBridgeTopUpTxHash: { type: String, trim: true },
    fiberLiquidityBridgeTopUpAmountMinor: { type: Number, min: 1 },
    fiberLiquidityBridgeTopUpStatus: { type: String, trim: true },
    fiberLiquidityBridgeTopUpCreatedAt: { type: Date },
    fiberChannelOpenProofId: { type: String, trim: true },
    fiberChannelOpenAmountMinor: { type: Number, min: 1 },
    fiberChannelOpenRequestedAt: { type: Date },
    fiberExitInvoice: { type: String, trim: true },
    fiberExitInvoiceHash: { type: String, trim: true },
    fiberExitPaymentProofId: { type: String, trim: true },
    fiberExitPaymentAttemptId: { type: String, trim: true },
    fiberExitSettlementTxHash: { type: String, trim: true },
    fiberExitSettlementStatus: { type: String, trim: true },
    fiberExitSettlementExplorerUrl: { type: String, trim: true },
    fiberExitSettledAt: { type: Date },
    payoutNotifiedAt: { type: Date },
    payoutNotificationStatus: { type: String, enum: ['not_required', 'pending', 'sent', 'failed'], default: 'not_required' },
    payoutNotificationFailure: { type: String, trim: true }
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
    appGrantOwnerWalletId: { type: String, trim: true },
    appGrantCreatedAt: { type: Date },
    chargePolicy: { type: String, trim: true },
    paymentPurpose: { type: String, enum: PAYMENT_PURPOSES, required: true, default: 'app_session', index: true },
    recipientName: { type: String, trim: true },
    recipientAddress: { type: String, trim: true },
    recipientWallets: { type: [recipientWalletSchema], default: [] },
    paymentReference: { type: String, trim: true },
    releaseCadence: { type: String, enum: RELEASE_CADENCES, required: true, default: 'none' },
    nextReleaseAt: { type: Date, index: true },
    maxChargeAmount: { type: Number, min: 0 },
    maxChargeAmountMinor: { type: Number, min: 0 },
    conditionSummary: { type: String, trim: true },
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
