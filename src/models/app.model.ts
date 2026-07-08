import { Schema, model, type InferSchemaType } from 'mongoose';

export const APP_STATUSES = ['pending_verification', 'active', 'suspended', 'revoked'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const API_KEY_STATUSES = ['active', 'revoked'] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

const appSchema = new Schema(
  {
    appId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    serviceAddress: { type: String, required: true, trim: true },
    url: { type: String, trim: true, default: '' },
    category: { type: String, trim: true, default: 'API' },
    description: { type: String, trim: true, default: '' },
    status: { type: String, enum: APP_STATUSES, required: true, default: 'active', index: true }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

const appApiKeySchema = new Schema(
  {
    keyId: { type: String, required: true, unique: true, index: true },
    appId: { type: String, required: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    keyHash: { type: String, required: true, unique: true, index: true },
    keyPrefix: { type: String, required: true },
    label: { type: String, trim: true, default: 'Default key' },
    status: { type: String, enum: API_KEY_STATUSES, required: true, default: 'active', index: true },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

appSchema.index({ ownerWalletId: 1, createdAt: -1 });
appApiKeySchema.index({ appId: 1, status: 1, createdAt: -1 });

export type AppRecord = InferSchemaType<typeof appSchema>;
export type AppApiKeyRecord = InferSchemaType<typeof appApiKeySchema>;

export const AppModel = model('App', appSchema);
export const AppApiKeyModel = model('AppApiKey', appApiKeySchema);
