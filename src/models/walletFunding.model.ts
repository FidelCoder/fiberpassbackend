import { Schema, model, type InferSchemaType } from 'mongoose';

export const WALLET_FUNDING_STATUSES = ['pending', 'confirmed'] as const;
export type WalletFundingStatus = (typeof WALLET_FUNDING_STATUSES)[number];
export const WALLET_FUNDING_DEPOSIT_MODES = ['treasury', 'vault'] as const;
export type WalletFundingDepositMode = (typeof WALLET_FUNDING_DEPOSIT_MODES)[number];

const walletFundingSchema = new Schema(
  {
    fundingId: { type: String, required: true, unique: true, index: true },
    walletId: { type: String, required: true, index: true },
    walletAddress: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, default: 'CKB' },
    network: { type: String, required: true, trim: true },
    depositMode: { type: String, enum: WALLET_FUNDING_DEPOSIT_MODES, required: true, trim: true, default: 'treasury' },
    depositAddress: { type: String, required: true, trim: true },
    vaultScriptHash: { type: String, trim: true, index: true },
    vaultScriptArgs: { type: String, trim: true },
    vaultOwnerLockHash: { type: String, trim: true },
    vaultOwnerLockHashSource: { type: String, trim: true },
    vaultAccountIdHash: { type: String, trim: true, index: true },
    memo: { type: String, required: true, trim: true },
    proofId: { type: String, trim: true },
    chainTxHash: { type: String, trim: true, index: true },
    chainOutputIndex: { type: String, trim: true },
    chainOutPoint: { type: String, trim: true, index: true },
    chainBlockHash: { type: String, trim: true },
    chainBlockNumber: { type: String, trim: true },
    chainCapacityShannons: { type: Number, min: 0 },
    chainConfirmedAt: { type: Date },
    status: { type: String, enum: WALLET_FUNDING_STATUSES, required: true, default: 'pending', index: true },
    confirmedAt: { type: Date }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

walletFundingSchema.index({ walletId: 1, createdAt: -1 });
walletFundingSchema.index({ proofId: 1 }, { unique: true, sparse: true });
walletFundingSchema.index({ chainOutPoint: 1 }, { unique: true, sparse: true });

export type WalletFundingRecord = InferSchemaType<typeof walletFundingSchema>;
export const WalletFundingModel = model('WalletFunding', walletFundingSchema);
