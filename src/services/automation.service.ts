import { randomUUID } from 'node:crypto';
import { AUTOMATION_AUDIT_ACTIONS } from '../domain/automation.js';
import { ApiError } from '../lib/errors.js';
import { FIBER_CKB_ADDRESS_ERROR, isFiberCkbAddress } from '../lib/fiberAddress.js';
import { AppModel } from '../models/app.model.js';
import { RecipientModel, type RecipientRecord } from '../models/automation.model.js';
import { writeAuditLog } from './audit.service.js';

export interface AutomationActor {
  appId: string;
  ownerWalletId: string;
  source: 'wallet' | 'app_api_key';
  keyId?: string;
}

export interface CreateRecipientInput {
  name: string;
  serviceAddress: string;
  externalId?: string;
  invoiceEndpoint?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateRecipientInput {
  name?: string;
  serviceAddress?: string;
  externalId?: string;
  invoiceEndpoint?: string;
  metadata?: Record<string, unknown>;
}

export interface RecipientDto {
  id: string;
  appId: string;
  name: string;
  serviceAddress: string;
  addressType: string;
  externalId?: string;
  invoiceEndpoint?: string;
  status: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
}

function newRecipientId(): string {
  return 'fp_rec_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function cleanOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function toMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toRecipientDto(record: RecipientRecord & { createdAt?: Date; updatedAt?: Date; disabledAt?: Date | null }): RecipientDto {
  return {
    id: record.recipientId,
    appId: record.appId,
    name: record.name,
    serviceAddress: record.serviceAddress,
    addressType: record.addressType,
    externalId: record.externalId ?? undefined,
    invoiceEndpoint: record.invoiceEndpoint ?? undefined,
    status: record.status,
    metadata: toMetadata(record.metadata),
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt ?? new Date()).toISOString(),
    disabledAt: record.disabledAt?.toISOString()
  };
}

function auditMetadata(actor: AutomationActor, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: actor.appId,
    source: actor.source,
    keyId: actor.keyId,
    ...extra
  };
}

async function ensureActorApp(actor: AutomationActor): Promise<void> {
  const app = await AppModel.exists({ appId: actor.appId, ownerWalletId: actor.ownerWalletId });
  if (!app) {
    throw new ApiError(404, 'APP_NOT_FOUND', 'Developer app was not found for this wallet.');
  }
}

function validateRecipientAddress(serviceAddress: string): void {
  if (!isFiberCkbAddress(serviceAddress)) {
    throw new ApiError(400, 'INVALID_RECIPIENT_ADDRESS', FIBER_CKB_ADDRESS_ERROR);
  }
}

export async function listRecipients(actor: AutomationActor): Promise<{ recipients: RecipientDto[] }> {
  await ensureActorApp(actor);
  const recipients = await RecipientModel.find({ appId: actor.appId, ownerWalletId: actor.ownerWalletId })
    .sort({ createdAt: -1 })
    .lean<(RecipientRecord & { createdAt?: Date; updatedAt?: Date; disabledAt?: Date })[]>();

  return { recipients: recipients.map(toRecipientDto) };
}

export async function createRecipient(actor: AutomationActor, input: CreateRecipientInput): Promise<RecipientDto> {
  await ensureActorApp(actor);
  validateRecipientAddress(input.serviceAddress);

  const recipientId = newRecipientId();
  const record = await RecipientModel.create({
    recipientId,
    ownerWalletId: actor.ownerWalletId,
    appId: actor.appId,
    name: input.name.trim(),
    serviceAddress: input.serviceAddress.trim(),
    addressType: 'ckb',
    externalId: cleanOptionalString(input.externalId),
    invoiceEndpoint: cleanOptionalString(input.invoiceEndpoint),
    status: 'active',
    metadata: input.metadata
  });

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.recipientCreated,
    targetType: 'recipient',
    targetId: recipientId,
    metadata: auditMetadata(actor, { externalId: cleanOptionalString(input.externalId) })
  });

  return toRecipientDto(record.toObject());
}

export async function updateRecipient(actor: AutomationActor, recipientId: string, input: UpdateRecipientInput): Promise<RecipientDto> {
  await ensureActorApp(actor);

  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  if (input.name !== undefined) set.name = input.name.trim();
  if (input.serviceAddress !== undefined) {
    validateRecipientAddress(input.serviceAddress);
    set.serviceAddress = input.serviceAddress.trim();
    set.addressType = 'ckb';
  }
  if (input.externalId !== undefined) {
    const externalId = cleanOptionalString(input.externalId);
    if (externalId) set.externalId = externalId;
    else unset.externalId = 1;
  }
  if (input.invoiceEndpoint !== undefined) {
    const invoiceEndpoint = cleanOptionalString(input.invoiceEndpoint);
    if (invoiceEndpoint) set.invoiceEndpoint = invoiceEndpoint;
    else unset.invoiceEndpoint = 1;
  }
  if (input.metadata !== undefined) set.metadata = input.metadata;

  const update: Record<string, unknown> = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (Object.keys(unset).length > 0) update.$unset = unset;

  if (Object.keys(update).length === 0) {
    throw new ApiError(400, 'RECIPIENT_UPDATE_EMPTY', 'At least one recipient field must be changed.');
  }

  const recipient = await RecipientModel.findOneAndUpdate(
    { recipientId, appId: actor.appId, ownerWalletId: actor.ownerWalletId, status: 'active' },
    update,
    { new: true }
  );

  if (!recipient) {
    throw new ApiError(404, 'RECIPIENT_NOT_FOUND', 'Recipient was not found for this app.');
  }

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.recipientUpdated,
    targetType: 'recipient',
    targetId: recipientId,
    metadata: auditMetadata(actor, { changedFields: Object.keys(set).concat(Object.keys(unset)) })
  });

  return toRecipientDto(recipient.toObject());
}

export async function disableRecipient(actor: AutomationActor, recipientId: string): Promise<RecipientDto> {
  await ensureActorApp(actor);

  const recipient = await RecipientModel.findOneAndUpdate(
    { recipientId, appId: actor.appId, ownerWalletId: actor.ownerWalletId, status: 'active' },
    { $set: { status: 'disabled', disabledAt: new Date() } },
    { new: true }
  );

  if (!recipient) {
    throw new ApiError(404, 'RECIPIENT_NOT_FOUND', 'Active recipient was not found for this app.');
  }

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.recipientDisabled,
    targetType: 'recipient',
    targetId: recipientId,
    metadata: auditMetadata(actor)
  });

  return toRecipientDto(recipient.toObject());
}
