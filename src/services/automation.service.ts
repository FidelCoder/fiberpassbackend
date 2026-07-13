import { createHash, randomUUID } from 'node:crypto';
import { AUTOMATION_AUDIT_ACTIONS, type PaymentBatchStatus } from '../domain/automation.js';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { fallbackMinorUnits, fromMinorUnits, toMinorUnits } from '../lib/money.js';
import { FIBER_CKB_ADDRESS_ERROR, isFiberCkbAddress } from '../lib/fiberAddress.js';
import { AppModel, type AppRecord } from '../models/app.model.js';
import { InvoiceModel, PaymentBatchModel, PaymentJobModel, RecipientModel, type InvoiceRecord, type PaymentBatchRecord, type PaymentJobRecord, type RecipientRecord } from '../models/automation.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { SessionModel, type SessionRecord } from '../models/session.model.js';
import { writeAuditLog } from './audit.service.js';
import { chargeSession } from './session.service.js';
import { enqueueWebhookEvent } from './webhook.service.js';

type InvoiceDocument = any;
type PaymentJobDocument = any;


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

export interface CreateInvoiceInput {
  sessionId: string;
  recipientId: string;
  amount: number;
  type?: string;
  description?: string;
  memo?: string;
  externalReference?: string;
  idempotencyKey?: string;
  fiberInvoice?: string;
  dueAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateInvoiceBatchInput {
  sessionId: string;
  description?: string;
  externalReference?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  invoices: Array<Omit<CreateInvoiceInput, 'sessionId'>>;
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

export interface InvoiceDto {
  id: string;
  appId: string;
  sessionId: string;
  recipientId: string;
  batchId?: string;
  amount: number;
  amountMinor: number;
  currency: string;
  status: string;
  type: string;
  description: string;
  memo: string;
  externalReference?: string;
  idempotencyKey?: string;
  fiberInvoiceHash?: string;
  hasFiberInvoice: boolean;
  chargeAttemptId?: string;
  paymentJobId?: string;
  dueAt?: string;
  queuedAt?: string;
  processingAt?: string;
  paidAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentJobDto {
  id: string;
  appId: string;
  sessionId: string;
  invoiceId: string;
  recipientId: string;
  batchId?: string;
  amount: number;
  amountMinor: number;
  currency: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockedAt?: string;
  lockedBy?: string;
  startedAt?: string;
  succeededAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentBatchDto {
  id: string;
  appId: string;
  sessionId: string;
  status: string;
  description: string;
  externalReference?: string;
  idempotencyKey?: string;
  totalAmount: number;
  totalAmountMinor: number;
  currency: string;
  invoiceCount: number;
  paidCount: number;
  failedCount: number;
  queuedAt?: string;
  processingAt?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  invoices: InvoiceDto[];
}

export interface PaymentWorkerRunResult {
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  cancelled: number;
}

export interface RunPaymentWorkerOptions {
  workerId?: string;
  limit?: number;
}


function newRecipientId(): string {
  return 'fp_rec_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function newInvoiceId(): string {
  return 'fp_inv_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function newBatchId(): string {
  return 'fp_batch_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function newJobId(): string {
  return 'fp_job_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

export function normalizeFiberInvoice(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function hashFiberInvoice(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex');
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

function toInvoiceDto(record: InvoiceRecord & { createdAt?: Date; updatedAt?: Date }): InvoiceDto {
  return {
    id: record.invoiceId,
    appId: record.appId,
    sessionId: record.sessionId,
    recipientId: record.recipientId,
    batchId: record.batchId ?? undefined,
    amount: fromMinorUnits(record.amountMinor, record.currency),
    amountMinor: record.amountMinor,
    currency: record.currency,
    status: record.status,
    type: record.type ?? 'Invoice payment',
    description: record.description ?? '',
    memo: record.memo ?? '',
    externalReference: record.externalReference ?? undefined,
    idempotencyKey: record.idempotencyKey ?? undefined,
    fiberInvoiceHash: record.fiberInvoiceHash ?? undefined,
    hasFiberInvoice: Boolean(record.fiberInvoice),
    chargeAttemptId: record.chargeAttemptId ?? undefined,
    paymentJobId: record.paymentJobId ?? undefined,
    dueAt: record.dueAt?.toISOString(),
    queuedAt: record.queuedAt?.toISOString(),
    processingAt: record.processingAt?.toISOString(),
    paidAt: record.paidAt?.toISOString(),
    failedAt: record.failedAt?.toISOString(),
    cancelledAt: record.cancelledAt?.toISOString(),
    lastFailureCode: record.lastFailureCode ?? undefined,
    lastFailureMessage: record.lastFailureMessage ?? undefined,
    metadata: toMetadata(record.metadata),
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt ?? new Date()).toISOString()
  };
}

function toPaymentBatchDto(
  record: PaymentBatchRecord & { createdAt?: Date; updatedAt?: Date },
  invoices: InvoiceDto[] = []
): PaymentBatchDto {
  return {
    id: record.batchId,
    appId: record.appId,
    sessionId: record.sessionId,
    status: record.status,
    description: record.description ?? '',
    externalReference: record.externalReference ?? undefined,
    idempotencyKey: record.idempotencyKey ?? undefined,
    totalAmount: fromMinorUnits(record.totalAmountMinor, record.currency),
    totalAmountMinor: record.totalAmountMinor,
    currency: record.currency,
    invoiceCount: record.invoiceCount,
    paidCount: record.paidCount,
    failedCount: record.failedCount,
    queuedAt: record.queuedAt?.toISOString(),
    processingAt: record.processingAt?.toISOString(),
    completedAt: record.completedAt?.toISOString(),
    failedAt: record.failedAt?.toISOString(),
    cancelledAt: record.cancelledAt?.toISOString(),
    lastFailureCode: record.lastFailureCode ?? undefined,
    lastFailureMessage: record.lastFailureMessage ?? undefined,
    metadata: toMetadata(record.metadata),
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt ?? new Date()).toISOString(),
    invoices
  };
}


function toPaymentJobDto(record: PaymentJobRecord & { createdAt?: Date; updatedAt?: Date }): PaymentJobDto {
  return {
    id: record.jobId,
    appId: record.appId,
    sessionId: record.sessionId,
    invoiceId: record.invoiceId,
    recipientId: record.recipientId,
    batchId: record.batchId ?? undefined,
    amount: fromMinorUnits(record.amountMinor, record.currency),
    amountMinor: record.amountMinor,
    currency: record.currency,
    status: record.status,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    runAfter: record.runAfter.toISOString(),
    lockedAt: record.lockedAt?.toISOString(),
    lockedBy: record.lockedBy ?? undefined,
    startedAt: record.startedAt?.toISOString(),
    succeededAt: record.succeededAt?.toISOString(),
    failedAt: record.failedAt?.toISOString(),
    cancelledAt: record.cancelledAt?.toISOString(),
    lastFailureCode: record.lastFailureCode ?? undefined,
    lastFailureMessage: record.lastFailureMessage ?? undefined,
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt ?? new Date()).toISOString()
  };
}

function safeEnqueueWebhookEvent(input: Parameters<typeof enqueueWebhookEvent>[0]): void {
  void enqueueWebhookEvent(input).catch(() => undefined);
}

function automationLimitMinor(value: number, currency: string): number {
  return toMinorUnits(String(value), currency);
}

async function dailyAutomationExposureMinor(actor: AutomationActor, currency: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const invoices = await InvoiceModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    currency,
    status: { $ne: 'cancelled' },
    createdAt: { $gte: startOfDay }
  }).select('amountMinor').lean<Array<{ amountMinor?: number }>>();
  return invoices.reduce((total, invoice) => total + (invoice.amountMinor ?? 0), 0);
}

async function validateAutomationSafetyLimits(input: {
  actor: AutomationActor;
  session: SessionRecord;
  amountMinor: number;
  kind: 'invoice' | 'batch';
}): Promise<void> {
  const currency = input.session.currency;
  const maxInvoiceMinor = automationLimitMinor(env.AUTOMATION_MAX_INVOICE_CKB, currency);
  const maxBatchMinor = automationLimitMinor(env.AUTOMATION_MAX_BATCH_CKB, currency);
  const dailyLimitMinor = automationLimitMinor(env.AUTOMATION_DAILY_LIMIT_CKB, currency);

  if (input.kind === 'invoice' && input.amountMinor > maxInvoiceMinor) {
    throw new ApiError(400, 'AUTOMATION_INVOICE_LIMIT_EXCEEDED', 'Invoice exceeds the per-invoice automation safety limit.');
  }
  if (input.kind === 'batch' && input.amountMinor > maxBatchMinor) {
    throw new ApiError(400, 'AUTOMATION_BATCH_LIMIT_EXCEEDED', 'Batch exceeds the per-batch automation safety limit.');
  }

  const exposureMinor = await dailyAutomationExposureMinor(input.actor, currency);
  if (exposureMinor + input.amountMinor > dailyLimitMinor) {
    throw new ApiError(429, 'AUTOMATION_DAILY_LIMIT_EXCEEDED', 'Automation daily limit reached for this app.');
  }
}

function normalizeOptionalDate(value?: string): Date | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, 'INVALID_INVOICE_DUE_DATE', 'Invoice due date must be a valid ISO date.');
  }
  return date;
}

function sessionSpentMinor(session: { spent?: number | null; spentMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(session.spentMinor, session.spent, session.currency ?? 'CKB');
}

function sessionLimitMinor(session: { limit?: number | null; limitMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(session.limitMinor, session.limit, session.currency ?? 'CKB');
}

function normalizedAddress(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}


function auditMetadata(actor: AutomationActor, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: actor.appId,
    source: actor.source,
    keyId: actor.keyId,
    ...extra
  };
}

async function ensureActorApp(actor: AutomationActor): Promise<AppRecord> {
  const app = await AppModel.findOne({ appId: actor.appId, ownerWalletId: actor.ownerWalletId }).lean<AppRecord>();
  if (!app) {
    throw new ApiError(404, 'APP_NOT_FOUND', 'Developer app was not found for this wallet.');
  }
  return app;
}

function validateRecipientAddress(serviceAddress: string): void {
  if (!isFiberCkbAddress(serviceAddress)) {
    throw new ApiError(400, 'INVALID_RECIPIENT_ADDRESS', FIBER_CKB_ADDRESS_ERROR);
  }
}


async function getRecipientForInvoice(actor: AutomationActor, recipientId: string): Promise<RecipientRecord> {
  const recipient = await RecipientModel.findOne({
    recipientId,
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    status: 'active'
  }).lean<RecipientRecord>();

  if (!recipient) {
    throw new ApiError(404, 'RECIPIENT_NOT_FOUND', 'Active recipient was not found for this app.');
  }
  return recipient;
}

async function getAutomationSession(actor: AutomationActor, sessionId: string, app: AppRecord): Promise<SessionRecord> {
  const session = await SessionModel.findOne({ publicId: sessionId, ownerWalletId: actor.ownerWalletId }).lean<SessionRecord>();
  if (!session) {
    throw new ApiError(404, 'SESSION_NOT_FOUND', 'FiberPass session was not found for this app owner.');
  }

  const appIdMatches = session.appId === actor.appId;
  const serviceAddressMatches = normalizedAddress(session.serviceAddress) === normalizedAddress(app.serviceAddress);
  if (!appIdMatches && !serviceAddressMatches) {
    throw new ApiError(403, 'APP_SESSION_MISMATCH', 'Invoice session is not authorized for this app.');
  }

  if (session.status !== 'active') {
    throw new ApiError(409, 'SESSION_NOT_CHARGEABLE', 'Invoices can only be created for active FiberPass sessions.');
  }

  if (!session.autoMicroCharges) {
    throw new ApiError(403, 'AUTOMATION_NOT_ALLOWED', 'This FiberPass was not created with automation permission enabled.');
  }

  const expiryAt = session.expiryAt instanceof Date ? session.expiryAt : undefined;
  if (expiryAt && expiryAt.getTime() <= Date.now()) {
    throw new ApiError(410, 'SESSION_EXPIRED', 'Invoices cannot be created for an expired FiberPass session.');
  }

  return session;
}

async function openInvoiceExposureMinor(actor: AutomationActor, sessionId: string): Promise<number> {
  const openInvoices = await InvoiceModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    sessionId,
    status: { $in: ['draft', 'queued', 'processing', 'failed'] }
  }).select('amountMinor').lean<Array<{ amountMinor?: number }>>();

  return openInvoices.reduce((total, invoice) => total + (invoice.amountMinor ?? 0), 0);
}

async function validateInvoiceCapacity(input: {
  actor: AutomationActor;
  session: SessionRecord;
  sessionId: string;
  newAmountMinor: number;
}): Promise<void> {
  const limitMinor = sessionLimitMinor(input.session);
  const spentMinor = sessionSpentMinor(input.session);
  const remainingMinor = Math.max(0, limitMinor - spentMinor);
  const openExposureMinor = await openInvoiceExposureMinor(input.actor, input.sessionId);

  if (openExposureMinor + input.newAmountMinor > remainingMinor) {
    throw new ApiError(402, 'SESSION_LIMIT_EXCEEDED', 'Invoice amount exceeds remaining FiberPass automation capacity.');
  }
}

function buildInvoiceRecord(input: {
  actor: AutomationActor;
  sessionId: string;
  batchId?: string;
  invoice: CreateInvoiceInput | Omit<CreateInvoiceInput, 'sessionId'>;
  amountMinor: number;
  currency: string;
}): Record<string, unknown> {
  const fiberInvoice = normalizeFiberInvoice(input.invoice.fiberInvoice);
  return {
    invoiceId: newInvoiceId(),
    ownerWalletId: input.actor.ownerWalletId,
    appId: input.actor.appId,
    sessionId: input.sessionId,
    recipientId: input.invoice.recipientId,
    batchId: input.batchId,
    amount: fromMinorUnits(input.amountMinor, input.currency),
    amountMinor: input.amountMinor,
    currency: input.currency,
    status: 'draft',
    type: cleanOptionalString(input.invoice.type) ?? 'Invoice payment',
    description: cleanOptionalString(input.invoice.description) ?? '',
    memo: cleanOptionalString(input.invoice.memo) ?? '',
    externalReference: cleanOptionalString(input.invoice.externalReference),
    idempotencyKey: cleanOptionalString(input.invoice.idempotencyKey),
    fiberInvoice,
    fiberInvoiceHash: fiberInvoice ? hashFiberInvoice(fiberInvoice) : undefined,
    dueAt: normalizeOptionalDate(input.invoice.dueAt),
    metadata: input.invoice.metadata
  };
}

function paymentJobIdempotencyKey(invoice: InvoiceRecord): string | undefined {
  return invoice.idempotencyKey ? invoice.idempotencyKey + ':payment-job' : undefined;
}

function ensureInvoicePaymentRequest(invoice: InvoiceRecord): string {
  const fiberInvoice = normalizeFiberInvoice(invoice.fiberInvoice ?? undefined);
  if (!fiberInvoice) {
    throw new ApiError(400, 'FIBER_INVOICE_REQUIRED', 'A Fiber invoice/payment request is required before an app/API or subscription invoice can be queued.');
  }
  return fiberInvoice;
}

function metadataPaymentRail(metadata: unknown): 'fiber' | 'vault' | undefined {
  const record = toMetadata(metadata);
  const value = typeof record?.paymentRail === 'string' ? record.paymentRail.trim().toLowerCase() : '';
  if (value === 'fiber' || value === 'vault') return value;
  return undefined;
}

async function invoicePaymentRail(invoice: InvoiceRecord): Promise<'fiber' | 'vault'> {
  const explicitRail = metadataPaymentRail(invoice.metadata);
  if (explicitRail) return explicitRail;
  if (normalizeFiberInvoice(invoice.fiberInvoice ?? undefined)) return 'fiber';

  const session = await SessionModel.findOne({ publicId: invoice.sessionId, ownerWalletId: invoice.ownerWalletId })
    .select('paymentPurpose')
    .lean<Pick<SessionRecord, 'paymentPurpose'> | null>();
  if (session?.paymentPurpose === 'scheduled_release' || session?.paymentPurpose === 'recurring_release') return 'vault';
  return 'fiber';
}

async function ensureInvoiceQueueablePayment(invoice: InvoiceRecord): Promise<'fiber' | 'vault'> {
  const rail = await invoicePaymentRail(invoice);
  if (rail === 'fiber') ensureInvoicePaymentRequest(invoice);
  return rail;
}

function failureFromError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'PAYMENT_JOB_FAILED', message: error.message };
  }
  return { code: 'PAYMENT_JOB_FAILED', message: 'Payment job failed.' };
}

const FATAL_PAYMENT_JOB_CODES = new Set([
  'APP_NOT_FOUND',
  'APP_SESSION_MISMATCH',
  'DAILY_SESSION_LIMIT_EXCEEDED',
  'FIBER_INVOICE_REQUIRED',
  'SESSION_EXPIRED',
  'SESSION_LIMIT_EXCEEDED',
  'SESSION_NOT_CHARGEABLE'
]);

export function isFatalPaymentJobError(code: string): boolean {
  return FATAL_PAYMENT_JOB_CODES.has(code);
}

export function paymentJobBackoffMs(attempts: number): number {
  const safeAttempts = Number.isFinite(attempts) ? Math.max(1, Math.min(7, Math.floor(attempts))) : 1;
  return Math.min(60000, 1000 * (2 ** (safeAttempts - 1)));
}

export function normalizePaymentWorkerId(value?: string): string {
  const normalized = value?.trim();
  return normalized || 'fiberpass-payment-worker';
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: number }).code === 11000;
}

async function loadInvoiceForActor(actor: AutomationActor, invoiceId: string): Promise<InvoiceDocument> {
  const invoice = await InvoiceModel.findOne({ invoiceId, appId: actor.appId, ownerWalletId: actor.ownerWalletId });
  if (!invoice) {
    throw new ApiError(404, 'INVOICE_NOT_FOUND', 'Invoice was not found for this app.');
  }
  return invoice;
}

async function loadBatchDto(actor: AutomationActor, batchId: string): Promise<PaymentBatchDto> {
  const [batch, invoices] = await Promise.all([
    PaymentBatchModel.findOne({ batchId, appId: actor.appId, ownerWalletId: actor.ownerWalletId }).lean<(PaymentBatchRecord & { createdAt?: Date; updatedAt?: Date }) | null>(),
    InvoiceModel.find({ batchId, appId: actor.appId, ownerWalletId: actor.ownerWalletId }).sort({ createdAt: 1 }).lean<(InvoiceRecord & { createdAt?: Date; updatedAt?: Date })[]>()
  ]);

  if (!batch) {
    throw new ApiError(404, 'PAYMENT_BATCH_NOT_FOUND', 'Payment batch was not found for this app.');
  }

  return toPaymentBatchDto(batch, invoices.map(toInvoiceDto));
}

async function refreshPaymentBatchRollup(actor: AutomationActor, batchId?: string): Promise<void> {
  if (!batchId) return;

  const [batch, invoices] = await Promise.all([
    PaymentBatchModel.findOne({ batchId, appId: actor.appId, ownerWalletId: actor.ownerWalletId }),
    InvoiceModel.find({ batchId, appId: actor.appId, ownerWalletId: actor.ownerWalletId }).select('status lastFailureCode lastFailureMessage').lean<Array<Pick<InvoiceRecord, 'status' | 'lastFailureCode' | 'lastFailureMessage'>>>()
  ]);

  if (!batch) return;

  const now = new Date();
  const invoiceCount = invoices.length;
  const paidCount = invoices.filter((invoice) => invoice.status === 'paid').length;
  const failedCount = invoices.filter((invoice) => invoice.status === 'failed').length;
  const cancelledCount = invoices.filter((invoice) => invoice.status === 'cancelled').length;
  const processingCount = invoices.filter((invoice) => invoice.status === 'processing').length;
  const queuedCount = invoices.filter((invoice) => invoice.status === 'queued').length;
  let nextStatus: PaymentBatchStatus = batch.status as PaymentBatchStatus;

  if (invoiceCount === 0) nextStatus = 'draft';
  else if (paidCount === invoiceCount) nextStatus = 'completed';
  else if (cancelledCount === invoiceCount) nextStatus = 'cancelled';
  else if (processingCount > 0) nextStatus = 'processing';
  else if (queuedCount > 0) nextStatus = 'queued';
  else if (paidCount > 0 && failedCount > 0) nextStatus = 'partial';
  else if (failedCount > 0) nextStatus = 'failed';
  else nextStatus = 'draft';

  const failedInvoice = invoices.find((invoice) => invoice.status === 'failed' && invoice.lastFailureCode);
  const previousStatus = batch.status;
  batch.status = nextStatus;
  batch.invoiceCount = invoiceCount;
  batch.paidCount = paidCount;
  batch.failedCount = failedCount;
  if (nextStatus === 'queued' && !batch.queuedAt) batch.queuedAt = now;
  if (nextStatus === 'processing' && !batch.processingAt) batch.processingAt = now;
  if (nextStatus === 'completed' && !batch.completedAt) batch.completedAt = now;
  if ((nextStatus === 'failed' || nextStatus === 'partial') && !batch.failedAt) batch.failedAt = now;
  if (nextStatus === 'cancelled' && !batch.cancelledAt) batch.cancelledAt = now;
  batch.lastFailureCode = failedInvoice?.lastFailureCode ?? undefined;
  batch.lastFailureMessage = failedInvoice?.lastFailureMessage ?? undefined;
  await batch.save();

  if (previousStatus !== nextStatus && nextStatus === 'completed') {
    safeEnqueueWebhookEvent({
      ownerWalletId: batch.ownerWalletId,
      appId: batch.appId,
      eventType: 'batch.completed',
      targetType: 'payment_batch',
      targetId: batch.batchId,
      payload: {
        batchId: batch.batchId,
        sessionId: batch.sessionId,
        status: nextStatus,
        invoiceCount,
        paidCount,
        failedCount
      }
    });
  }
}

async function createOrResetPaymentJob(actor: AutomationActor, invoice: InvoiceDocument, now: Date): Promise<PaymentJobDocument> {
  const runAfter = invoice.dueAt && invoice.dueAt.getTime() > now.getTime() ? invoice.dueAt : now;
  let job = await PaymentJobModel.findOne({ invoiceId: invoice.invoiceId });

  if (!job) {
    try {
      job = await PaymentJobModel.create({
        jobId: newJobId(),
        ownerWalletId: actor.ownerWalletId,
        appId: actor.appId,
        sessionId: invoice.sessionId,
        invoiceId: invoice.invoiceId,
        recipientId: invoice.recipientId,
        batchId: invoice.batchId,
        amount: fromMinorUnits(invoice.amountMinor, invoice.currency),
        amountMinor: invoice.amountMinor,
        currency: invoice.currency,
        status: 'queued',
        idempotencyKey: paymentJobIdempotencyKey(invoice.toObject()),
        runAfter,
        attempts: 0,
        maxAttempts: 3,
        metadata: auditMetadata(actor, {
          queuedBy: actor.source,
          queuedByKeyId: actor.keyId,
          fiberInvoiceHash: invoice.fiberInvoiceHash
        })
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      job = await PaymentJobModel.findOne({ invoiceId: invoice.invoiceId });
    }
  }

  if (!job) {
    throw new ApiError(500, 'PAYMENT_JOB_CREATE_FAILED', 'Payment job could not be created for this invoice.');
  }

  if (job.status === 'failed' || job.status === 'cancelled') {
    job.status = 'queued';
    job.runAfter = runAfter;
    job.attempts = 0;
    job.failedAt = undefined;
    job.cancelledAt = undefined;
    job.lastFailureCode = undefined;
    job.lastFailureMessage = undefined;
    job.set('lockedAt', undefined);
    job.set('lockedBy', undefined);
    await job.save();
  }

  return job;
}

async function queueInvoiceDocument(actor: AutomationActor, invoice: InvoiceDocument): Promise<void> {
  if (invoice.status === 'paid' || invoice.status === 'cancelled') {
    throw new ApiError(409, 'INVOICE_FINAL', 'Paid or cancelled invoices cannot be queued again.');
  }

  await ensureInvoiceQueueablePayment(invoice.toObject());
  const now = new Date();
  const job = await createOrResetPaymentJob(actor, invoice, now);
  const nextInvoiceStatus = job.status === 'processing' || job.status === 'locked' ? 'processing' : 'queued';

  invoice.status = nextInvoiceStatus;
  invoice.queuedAt = invoice.queuedAt ?? now;
  invoice.paymentJobId = job.jobId;
  invoice.failedAt = undefined;
  invoice.lastFailureCode = undefined;
  invoice.lastFailureMessage = undefined;
  await invoice.save();

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.invoiceQueued,
    targetType: 'invoice',
    targetId: invoice.invoiceId,
    metadata: auditMetadata(actor, { jobId: job.jobId, sessionId: invoice.sessionId, batchId: invoice.batchId })
  });

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.jobQueued,
    targetType: 'payment_job',
    targetId: job.jobId,
    metadata: auditMetadata(actor, { invoiceId: invoice.invoiceId, sessionId: invoice.sessionId, batchId: invoice.batchId })
  });

  await refreshPaymentBatchRollup(actor, invoice.batchId ?? undefined);
}


async function cancelSessionAutomationAfterFatalFailure(actor: AutomationActor, sessionId: string, failure: { code: string; message: string }): Promise<void> {
  const now = new Date();
  await PaymentJobModel.updateMany(
    { sessionId, appId: actor.appId, ownerWalletId: actor.ownerWalletId, status: { $in: ['queued', 'retrying', 'locked'] } },
    { $set: { status: 'cancelled', cancelledAt: now, lastFailureCode: failure.code, lastFailureMessage: failure.message } }
  );
  await InvoiceModel.updateMany(
    { sessionId, appId: actor.appId, ownerWalletId: actor.ownerWalletId, status: { $in: ['draft', 'queued'] } },
    { $set: { status: 'failed', failedAt: now, lastFailureCode: failure.code, lastFailureMessage: failure.message } }
  );

  const batchIds = await InvoiceModel.distinct('batchId', {
    sessionId,
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    batchId: { $exists: true, $ne: null }
  });
  for (const batchId of batchIds.filter(Boolean)) {
    await refreshPaymentBatchRollup(actor, String(batchId));
  }
}

async function cancelBatchAfterFatalFailure(actor: AutomationActor, batchId: string, failure: { code: string; message: string }): Promise<void> {
  const now = new Date();
  await PaymentJobModel.updateMany(
    { batchId, appId: actor.appId, ownerWalletId: actor.ownerWalletId, status: { $in: ['queued', 'retrying', 'locked', 'processing'] } },
    { $set: { status: 'cancelled', cancelledAt: now, lastFailureCode: failure.code, lastFailureMessage: failure.message } }
  );
  await InvoiceModel.updateMany(
    { batchId, appId: actor.appId, ownerWalletId: actor.ownerWalletId, status: { $in: ['draft', 'queued', 'processing'] } },
    { $set: { status: 'failed', failedAt: now, lastFailureCode: failure.code, lastFailureMessage: failure.message } }
  );
  await refreshPaymentBatchRollup(actor, batchId);
  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.batchFailed,
    targetType: 'payment_batch',
    targetId: batchId,
    metadata: auditMetadata(actor, failure)
  });
}

async function lockNextPaymentJob(workerId: string): Promise<PaymentJobDocument | null> {
  const now = new Date();
  const job = await PaymentJobModel.findOneAndUpdate(
    { status: { $in: ['queued', 'retrying'] }, runAfter: { $lte: now } },
    { $set: { status: 'locked', lockedAt: now, lockedBy: workerId }, $inc: { attempts: 1 } },
    { new: true, sort: { runAfter: 1, createdAt: 1 } }
  );

  if (job) {
    await writeAuditLog({
      actorWalletId: job.ownerWalletId,
      action: AUTOMATION_AUDIT_ACTIONS.jobLocked,
      targetType: 'payment_job',
      targetId: job.jobId,
      metadata: { appId: job.appId, sessionId: job.sessionId, invoiceId: job.invoiceId, workerId }
    });
  }

  return job;
}

async function processPaymentJob(job: PaymentJobDocument, workerId: string): Promise<'succeeded' | 'failed' | 'retried' | 'cancelled'> {
  const actor: AutomationActor = { appId: job.appId, ownerWalletId: job.ownerWalletId, source: 'wallet' };
  const startedAt = new Date();
  job.status = 'processing';
  job.startedAt = startedAt;
  await job.save();

  const failJob = async (failure: { code: string; message: string }): Promise<'failed' | 'retried'> => {
    const now = new Date();
    const canRetry = job.attempts < job.maxAttempts && !isFatalPaymentJobError(failure.code);
    job.lastFailureCode = failure.code;
    job.lastFailureMessage = failure.message;
    job.set('lockedAt', undefined);
    job.set('lockedBy', undefined);

    if (canRetry) {
      job.status = 'retrying';
      job.runAfter = new Date(now.getTime() + paymentJobBackoffMs(job.attempts));
      await job.save();
      await writeAuditLog({
        actorWalletId: job.ownerWalletId,
        action: AUTOMATION_AUDIT_ACTIONS.jobRetrying,
        targetType: 'payment_job',
        targetId: job.jobId,
        metadata: { appId: job.appId, invoiceId: job.invoiceId, sessionId: job.sessionId, failureCode: failure.code, runAfter: job.runAfter }
      });
      return 'retried';
    }

    job.status = 'failed';
    job.failedAt = now;
    await job.save();
    await writeAuditLog({
      actorWalletId: job.ownerWalletId,
      action: AUTOMATION_AUDIT_ACTIONS.jobFailed,
      targetType: 'payment_job',
      targetId: job.jobId,
      metadata: { appId: job.appId, invoiceId: job.invoiceId, sessionId: job.sessionId, failureCode: failure.code }
    });
    return 'failed';
  };

  const invoice = await InvoiceModel.findOne({
    invoiceId: job.invoiceId,
    appId: job.appId,
    ownerWalletId: job.ownerWalletId
  });

  if (!invoice) {
    return failJob({ code: 'INVOICE_NOT_FOUND', message: 'Queued invoice no longer exists.' });
  }

  if (invoice.status === 'paid') {
    job.status = 'succeeded';
    job.succeededAt = new Date();
    await job.save();
    return 'succeeded';
  }

  if (invoice.status === 'cancelled') {
    job.status = 'cancelled';
    job.cancelledAt = new Date();
    await job.save();
    return 'cancelled';
  }

  try {
    const app = await AppModel.findOne({ appId: job.appId, ownerWalletId: job.ownerWalletId }).lean<AppRecord>();
    if (!app) {
      throw new ApiError(404, 'APP_NOT_FOUND', 'Developer app was not found for this payment job.');
    }

    const recipient = await RecipientModel.findOne({
      recipientId: invoice.recipientId,
      appId: job.appId,
      ownerWalletId: job.ownerWalletId
    }).lean<RecipientRecord>();
    if (!recipient) {
      throw new ApiError(404, 'RECIPIENT_NOT_FOUND', 'Payment job recipient was not found.');
    }

    const paymentRail = await invoicePaymentRail(invoice.toObject());
    const fiberInvoice = paymentRail === 'fiber' ? ensureInvoicePaymentRequest(invoice.toObject()) : undefined;
    const invoiceMetadata = toMetadata(invoice.metadata) ?? {};
    const jobMetadata = toMetadata(job.metadata) ?? {};
    const queuedByKeyId = typeof jobMetadata.queuedByKeyId === 'string' && jobMetadata.queuedByKeyId.trim()
      ? jobMetadata.queuedByKeyId.trim()
      : undefined;
    invoice.status = 'processing';
    invoice.processingAt = startedAt;
    await invoice.save();
    await refreshPaymentBatchRollup(actor, invoice.batchId ?? undefined);

    await chargeSession({
      sessionId: invoice.sessionId,
      amount: fromMinorUnits(invoice.amountMinor, invoice.currency),
      type: invoice.type ?? 'Invoice payment',
      appId: invoice.appId,
      apiKeyId: queuedByKeyId,
      appServiceAddress: app.serviceAddress,
      idempotencyKey: job.idempotencyKey ?? job.jobId,
      serviceReference: invoice.externalReference ?? invoice.invoiceId,
      paymentRequest: fiberInvoice,
      metadata: {
        ...invoiceMetadata,
        paymentRail,
        ...(fiberInvoice ? { fiberInvoice } : {}),
        ...(paymentRail === 'vault' ? { directVaultPayout: true } : {}),
        automationInvoiceId: invoice.invoiceId,
        automationJobId: job.jobId,
        idempotencyKey: job.idempotencyKey ?? job.jobId,
        serviceReference: invoice.externalReference ?? invoice.invoiceId,
        recipientId: invoice.recipientId,
        recipientAddress: recipient.serviceAddress,
        recipientName: recipient.name,
        batchId: invoice.batchId
      }
    });

    const chargeAttempt = await ChargeAttemptModel.findOne({
      sessionId: invoice.sessionId,
      appId: invoice.appId,
      'metadata.automationInvoiceId': invoice.invoiceId
    }).sort({ createdAt: -1 }).lean<{ attemptId: string } | null>();

    invoice.status = 'paid';
    invoice.paidAt = new Date();
    invoice.chargeAttemptId = chargeAttempt?.attemptId;
    invoice.lastFailureCode = undefined;
    invoice.lastFailureMessage = undefined;
    await invoice.save();

    job.status = 'succeeded';
    job.succeededAt = new Date();
    job.lastFailureCode = undefined;
    job.lastFailureMessage = undefined;
    await job.save();

    await writeAuditLog({
      actorWalletId: job.ownerWalletId,
      action: AUTOMATION_AUDIT_ACTIONS.invoicePaid,
      targetType: 'invoice',
      targetId: invoice.invoiceId,
      metadata: { appId: invoice.appId, sessionId: invoice.sessionId, jobId: job.jobId, chargeAttemptId: invoice.chargeAttemptId, workerId }
    });
    await writeAuditLog({
      actorWalletId: job.ownerWalletId,
      action: AUTOMATION_AUDIT_ACTIONS.jobSucceeded,
      targetType: 'payment_job',
      targetId: job.jobId,
      metadata: { appId: job.appId, invoiceId: job.invoiceId, sessionId: job.sessionId, workerId }
    });

    safeEnqueueWebhookEvent({
      ownerWalletId: job.ownerWalletId,
      appId: invoice.appId,
      eventType: 'invoice.paid',
      targetType: 'invoice',
      targetId: invoice.invoiceId,
      payload: { invoice: toInvoiceDto(invoice.toObject()) }
    });

    const session = await SessionModel.findOne({ publicId: invoice.sessionId }).lean<SessionRecord | null>();
    if (session && session.status === 'expired' && sessionLimitMinor(session) <= sessionSpentMinor(session)) {
      safeEnqueueWebhookEvent({
        ownerWalletId: job.ownerWalletId,
        appId: invoice.appId,
        eventType: 'session.limit_exhausted',
        targetType: 'session',
        targetId: invoice.sessionId,
        payload: { sessionId: invoice.sessionId, status: session.status, spentMinor: sessionSpentMinor(session), limitMinor: sessionLimitMinor(session) }
      });
    }

    await refreshPaymentBatchRollup(actor, invoice.batchId ?? undefined);
    return 'succeeded';
  } catch (error) {
    const failure = failureFromError(error);
    const chargeAttempt = await ChargeAttemptModel.findOne({
      sessionId: invoice.sessionId,
      appId: invoice.appId,
      'metadata.automationInvoiceId': invoice.invoiceId
    }).sort({ createdAt: -1 }).lean<{ attemptId: string } | null>();
    invoice.status = 'failed';
    invoice.failedAt = new Date();
    invoice.chargeAttemptId = chargeAttempt?.attemptId ?? invoice.chargeAttemptId;
    invoice.lastFailureCode = failure.code;
    invoice.lastFailureMessage = failure.message;
    await invoice.save();

    await writeAuditLog({
      actorWalletId: job.ownerWalletId,
      action: AUTOMATION_AUDIT_ACTIONS.invoiceFailed,
      targetType: 'invoice',
      targetId: invoice.invoiceId,
      metadata: { appId: invoice.appId, sessionId: invoice.sessionId, jobId: job.jobId, failureCode: failure.code }
    });

    safeEnqueueWebhookEvent({
      ownerWalletId: job.ownerWalletId,
      appId: invoice.appId,
      eventType: 'invoice.failed',
      targetType: 'invoice',
      targetId: invoice.invoiceId,
      payload: { invoice: toInvoiceDto(invoice.toObject()), failure }
    });

    const outcome = await failJob(failure);
    if (isFatalPaymentJobError(failure.code)) {
      await cancelSessionAutomationAfterFatalFailure(actor, invoice.sessionId, failure);
      if (invoice.batchId) {
        await cancelBatchAfterFatalFailure(actor, invoice.batchId, failure);
      }
    } else {
      await refreshPaymentBatchRollup(actor, invoice.batchId ?? undefined);
    }
    return outcome;
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

export async function listInvoices(actor: AutomationActor, sessionId?: string): Promise<{ invoices: InvoiceDto[] }> {
  await ensureActorApp(actor);
  const invoices = await InvoiceModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    ...(sessionId ? { sessionId } : {})
  }).sort({ createdAt: -1 }).limit(200).lean<(InvoiceRecord & { createdAt?: Date; updatedAt?: Date })[]>();

  return { invoices: invoices.map(toInvoiceDto) };
}

export async function createInvoice(actor: AutomationActor, input: CreateInvoiceInput): Promise<InvoiceDto> {
  const app = await ensureActorApp(actor);
  await getRecipientForInvoice(actor, input.recipientId);
  const session = await getAutomationSession(actor, input.sessionId, app);
  const amountMinor = toMinorUnits(String(input.amount), session.currency);
  if (amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_INVOICE_AMOUNT', 'Invoice amount must be greater than zero.');
  }

  await validateAutomationSafetyLimits({ actor, session, amountMinor, kind: 'invoice' });
  await validateInvoiceCapacity({ actor, session, sessionId: input.sessionId, newAmountMinor: amountMinor });
  const invoiceRecord = buildInvoiceRecord({ actor, sessionId: input.sessionId, invoice: input, amountMinor, currency: session.currency });
  const invoice = await InvoiceModel.create(invoiceRecord);

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.invoiceCreated,
    targetType: 'invoice',
    targetId: invoice.invoiceId,
    metadata: auditMetadata(actor, {
      sessionId: input.sessionId,
      recipientId: input.recipientId,
      amountMinor,
      hasFiberInvoice: Boolean(normalizeFiberInvoice(input.fiberInvoice))
    })
  });

  return toInvoiceDto(invoice.toObject());
}

export async function createInvoiceBatch(actor: AutomationActor, input: CreateInvoiceBatchInput): Promise<PaymentBatchDto> {
  const app = await ensureActorApp(actor);
  if (input.invoices.length === 0) {
    throw new ApiError(400, 'BATCH_EMPTY', 'Invoice batch must include at least one invoice.');
  }

  const session = await getAutomationSession(actor, input.sessionId, app);
  const batchId = newBatchId();
  let totalAmountMinor = 0;
  const invoiceRecords: Record<string, unknown>[] = [];

  for (const invoice of input.invoices) {
    await getRecipientForInvoice(actor, invoice.recipientId);
    const amountMinor = toMinorUnits(String(invoice.amount), session.currency);
    if (amountMinor <= 0) {
      throw new ApiError(400, 'INVALID_INVOICE_AMOUNT', 'Invoice amount must be greater than zero.');
    }
    if (amountMinor > automationLimitMinor(env.AUTOMATION_MAX_INVOICE_CKB, session.currency)) {
      throw new ApiError(400, 'AUTOMATION_INVOICE_LIMIT_EXCEEDED', 'One or more batch invoices exceed the per-invoice automation safety limit.');
    }
    totalAmountMinor += amountMinor;
    invoiceRecords.push(buildInvoiceRecord({ actor, sessionId: input.sessionId, batchId, invoice, amountMinor, currency: session.currency }));
  }

  await validateAutomationSafetyLimits({ actor, session, amountMinor: totalAmountMinor, kind: 'batch' });
  await validateInvoiceCapacity({ actor, session, sessionId: input.sessionId, newAmountMinor: totalAmountMinor });

  const batch = await PaymentBatchModel.create({
    batchId,
    ownerWalletId: actor.ownerWalletId,
    appId: actor.appId,
    sessionId: input.sessionId,
    status: 'draft',
    description: cleanOptionalString(input.description) ?? '',
    externalReference: cleanOptionalString(input.externalReference),
    idempotencyKey: cleanOptionalString(input.idempotencyKey),
    totalAmount: fromMinorUnits(totalAmountMinor, session.currency),
    totalAmountMinor,
    currency: session.currency,
    invoiceCount: invoiceRecords.length,
    paidCount: 0,
    failedCount: 0,
    metadata: input.metadata
  });
  await InvoiceModel.insertMany(invoiceRecords);
  const invoices = await InvoiceModel.find({ batchId }).sort({ createdAt: 1 }).lean<(InvoiceRecord & { createdAt?: Date; updatedAt?: Date })[]>();

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.batchCreated,
    targetType: 'payment_batch',
    targetId: batchId,
    metadata: auditMetadata(actor, {
      sessionId: input.sessionId,
      invoiceCount: invoiceRecords.length,
      totalAmountMinor
    })
  });

  return toPaymentBatchDto(batch.toObject(), invoices.map(toInvoiceDto));
}

export async function listPaymentBatches(actor: AutomationActor, sessionId?: string): Promise<{ batches: PaymentBatchDto[] }> {
  await ensureActorApp(actor);
  const batches = await PaymentBatchModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    ...(sessionId ? { sessionId } : {})
  }).sort({ createdAt: -1 }).limit(100).lean<(PaymentBatchRecord & { createdAt?: Date; updatedAt?: Date })[]>();

  const batchIds = batches.map((batch) => batch.batchId);
  const invoices = batchIds.length === 0
    ? []
    : await InvoiceModel.find({ batchId: { $in: batchIds }, appId: actor.appId, ownerWalletId: actor.ownerWalletId })
        .sort({ createdAt: 1 })
        .lean<(InvoiceRecord & { createdAt?: Date; updatedAt?: Date })[]>();

  return {
    batches: batches.map((batch) => toPaymentBatchDto(
      batch,
      invoices.filter((invoice) => invoice.batchId === batch.batchId).map(toInvoiceDto)
    ))
  };
}


export async function listPaymentJobs(actor: AutomationActor, sessionId?: string): Promise<{ jobs: PaymentJobDto[] }> {
  await ensureActorApp(actor);
  const jobs = await PaymentJobModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    ...(sessionId ? { sessionId } : {})
  }).sort({ createdAt: -1 }).limit(200).lean<(PaymentJobRecord & { createdAt?: Date; updatedAt?: Date })[]>();

  return { jobs: jobs.map(toPaymentJobDto) };
}

export async function queueInvoice(actor: AutomationActor, invoiceId: string): Promise<InvoiceDto> {
  await ensureActorApp(actor);
  const invoice = await loadInvoiceForActor(actor, invoiceId);
  await queueInvoiceDocument(actor, invoice);
  return toInvoiceDto(invoice.toObject());
}

export async function queueInvoiceBatch(actor: AutomationActor, batchId: string): Promise<PaymentBatchDto> {
  await ensureActorApp(actor);
  const batch = await PaymentBatchModel.findOne({ batchId, appId: actor.appId, ownerWalletId: actor.ownerWalletId });
  if (!batch) {
    throw new ApiError(404, 'PAYMENT_BATCH_NOT_FOUND', 'Payment batch was not found for this app.');
  }

  if (batch.status === 'completed' || batch.status === 'cancelled') {
    throw new ApiError(409, 'PAYMENT_BATCH_FINAL', 'Completed or cancelled batches cannot be queued again.');
  }

  const invoices = await InvoiceModel.find({ batchId, appId: actor.appId, ownerWalletId: actor.ownerWalletId }).sort({ createdAt: 1 });
  if (invoices.length === 0) {
    throw new ApiError(400, 'PAYMENT_BATCH_EMPTY', 'Payment batch has no invoices to queue.');
  }

  for (const invoice of invoices) {
    if (invoice.status !== 'paid' && invoice.status !== 'cancelled') {
      await ensureInvoiceQueueablePayment(invoice.toObject());
    }
  }

  batch.status = 'queued';
  batch.queuedAt = batch.queuedAt ?? new Date();
  await batch.save();

  for (const invoice of invoices) {
    if (invoice.status !== 'paid' && invoice.status !== 'cancelled') {
      await queueInvoiceDocument(actor, invoice);
    }
  }

  await refreshPaymentBatchRollup(actor, batchId);
  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.batchQueued,
    targetType: 'payment_batch',
    targetId: batchId,
    metadata: auditMetadata(actor, { invoiceCount: invoices.length, sessionId: batch.sessionId })
  });

  return loadBatchDto(actor, batchId);
}

export async function runPaymentWorkerOnce(options: RunPaymentWorkerOptions = {}): Promise<PaymentWorkerRunResult> {
  const workerId = normalizePaymentWorkerId(options.workerId);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 10)));
  const result: PaymentWorkerRunResult = { processed: 0, succeeded: 0, failed: 0, retried: 0, cancelled: 0 };

  for (let index = 0; index < limit; index += 1) {
    const job = await lockNextPaymentJob(workerId);
    if (!job) break;

    const outcome = await processPaymentJob(job, workerId);
    result.processed += 1;
    result[outcome] += 1;
  }

  return result;
}

