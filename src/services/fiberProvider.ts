import { env } from '../config/env.js';

export type FiberProviderKind = 'rpc';
export type FiberSessionStatus = 'pending' | 'active' | 'paused' | 'closing' | 'settled' | 'revoked' | 'expired' | 'failed';
export type FiberSettlementReason = 'revoked' | 'settled' | 'expired';

export interface FiberMoneyInput {
  amountMinor: number;
  currency: string;
}

export interface FiberCreateSessionInput extends FiberMoneyInput {
  localSessionId: string;
  walletId: string;
  appAddress: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface FiberCreateSessionResult {
  provider: FiberProviderKind;
  network: string;
  networkSessionId: string;
  status: FiberSessionStatus;
  proofId?: string;
  raw?: unknown;
}

export interface FiberAuthorizeChargeInput extends FiberMoneyInput {
  sessionId: string;
  networkSessionId?: string;
  appAddress: string;
  paymentRequest?: string;
  metadata?: Record<string, unknown>;
}

export interface FiberChargeResult {
  provider: FiberProviderKind;
  network: string;
  authorized: true;
  proofId: string;
  status: 'Success';
  raw?: unknown;
}

export type FiberInvoiceCurrency = 'Fibb' | 'Fibt' | 'Fibd';

export interface FiberParsedInvoice {
  amountMinor?: number;
  currency: FiberInvoiceCurrency;
  paymentHash: string;
  createdAtSeconds: number;
  expiresAtSeconds?: number;
  payeePubkey?: string;
  hasUdtScript: boolean;
  signed: boolean;
  raw?: unknown;
}

export type FiberPaymentStatus = 'Created' | 'Inflight' | 'Success' | 'Failed';

export interface FiberPaymentStatusResult {
  provider: FiberProviderKind;
  network: string;
  paymentHash: string;
  status: FiberPaymentStatus;
  failure?: string;
  raw?: unknown;
}

export interface FiberTopUpInput extends FiberMoneyInput {
  sessionId: string;
  networkSessionId?: string;
  walletId: string;
}

export interface FiberTopUpResult {
  provider: FiberProviderKind;
  network: string;
  proofId: string;
  raw?: unknown;
}

export interface FiberSettleInput extends FiberMoneyInput {
  sessionId: string;
  networkSessionId?: string;
  reason: FiberSettlementReason;
}

export interface FiberSettleResult {
  provider: FiberProviderKind;
  network: string;
  settled: true;
  proofId: string;
  raw?: unknown;
}

export interface FiberStatusResult {
  provider: FiberProviderKind;
  network: string;
  status: FiberSessionStatus;
  networkSessionId?: string;
  raw?: unknown;
}

export interface FiberProvider {
  readonly kind: FiberProviderKind;
  readonly network: string;
  createSession(input: FiberCreateSessionInput): Promise<FiberCreateSessionResult>;
  parseInvoice(paymentRequest: string): Promise<FiberParsedInvoice>;
  getPayment(paymentHash: string): Promise<FiberPaymentStatusResult>;
  authorizeCharge(input: FiberAuthorizeChargeInput): Promise<FiberChargeResult>;
  topUpSession(input: FiberTopUpInput): Promise<FiberTopUpResult>;
  revokeSession(input: FiberSettleInput): Promise<FiberSettleResult>;
  settleSession(input: FiberSettleInput): Promise<FiberSettleResult>;
  getStatus(sessionId: string, networkSessionId?: string): Promise<FiberStatusResult>;
}

function fiberRpcHexQuantity(value: number): string {
  return '0x' + BigInt(Math.trunc(value)).toString(16);
}

function rpcSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('Fiber invoice is missing ' + field + '.');
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error('Fiber invoice has an invalid ' + field + '.');
  }
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Fiber invoice ' + field + ' exceeds the safe integer range.');
  }
  return Number(parsed);
}

function invoiceAttribute(attrs: unknown, name: string): unknown {
  if (!Array.isArray(attrs)) return undefined;
  for (const attribute of attrs) {
    if (attribute && typeof attribute === 'object' && name in attribute) {
      return (attribute as Record<string, unknown>)[name];
    }
  }
  return undefined;
}

export function parseFiberInvoiceRpcResult(raw: unknown): FiberParsedInvoice {
  const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const invoice = result.invoice && typeof result.invoice === 'object' ? result.invoice as Record<string, unknown> : {};
  const data = invoice.data && typeof invoice.data === 'object' ? invoice.data as Record<string, unknown> : {};
  const currency = invoice.currency;
  if (currency !== 'Fibb' && currency !== 'Fibt' && currency !== 'Fibd') {
    throw new Error('Fiber invoice has an unsupported currency.');
  }

  const paymentHash = typeof data.payment_hash === 'string' ? data.payment_hash.trim() : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(paymentHash)) {
    throw new Error('Fiber invoice has an invalid payment hash.');
  }

  const createdAtSeconds = rpcSafeInteger(data.timestamp, 'timestamp');
  const expiryValue = invoiceAttribute(data.attrs, 'expiry_time');
  const expirySeconds = expiryValue == null ? undefined : rpcSafeInteger(expiryValue, 'expiry');
  const payeeValue = invoiceAttribute(data.attrs, 'payee_public_key');

  return {
    amountMinor: invoice.amount == null ? undefined : rpcSafeInteger(invoice.amount, 'amount'),
    currency,
    paymentHash: paymentHash.toLowerCase(),
    createdAtSeconds,
    expiresAtSeconds: expirySeconds == null ? undefined : createdAtSeconds + expirySeconds,
    payeePubkey: typeof payeeValue === 'string' && payeeValue.trim() ? payeeValue.trim() : undefined,
    hasUdtScript: invoiceAttribute(data.attrs, 'udt_script') != null,
    signed: typeof invoice.signature === 'string' && invoice.signature.trim().length > 0,
    raw
  };
}

export class RpcFiberProvider implements FiberProvider {
  readonly kind = 'rpc' as const;
  readonly network: string;
  private readonly rpcUrl: string;
  private nextId = 1;

  constructor(input: { rpcUrl: string; network?: string }) {
    this.rpcUrl = input.rpcUrl;
    this.network = input.network ?? env.FIBER_NETWORK;
  }

  async createSession(input: FiberCreateSessionInput): Promise<FiberCreateSessionResult> {
    const channelPeerId = typeof input.metadata?.fiberPeerId === 'string' ? input.metadata.fiberPeerId.trim() : '';
    if (!channelPeerId) {
      throw new Error('An external Fiber peer id is required to open a Fiber channel.');
    }

    const raw = await this.rpc('open_channel', [{
      pubkey: channelPeerId,
      funding_amount: '0x' + BigInt(input.amountMinor).toString(16),
      public: true,
      shutdown_script: typeof input.metadata?.shutdownScript === 'string' ? input.metadata.shutdownScript : undefined
    }]);

    return {
      provider: this.kind,
      network: this.network,
      networkSessionId: String((raw as { channel_id?: unknown; temporary_channel_id?: unknown })?.channel_id ?? (raw as { temporary_channel_id?: unknown })?.temporary_channel_id ?? input.localSessionId),
      status: 'pending',
      proofId: String((raw as { tx_hash?: unknown; temporary_channel_id?: unknown })?.tx_hash ?? (raw as { temporary_channel_id?: unknown })?.temporary_channel_id ?? ''),
      raw
    };
  }

  async parseInvoice(paymentRequest: string): Promise<FiberParsedInvoice> {
    return parseFiberInvoiceRpcResult(await this.rpc('parse_invoice', [{ invoice: paymentRequest }]));
  }

  async getPayment(paymentHash: string): Promise<FiberPaymentStatusResult> {
    const raw = await this.rpc('get_payment', [{ payment_hash: paymentHash }]);
    const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const status = result.status;
    if (status !== 'Created' && status !== 'Inflight' && status !== 'Success' && status !== 'Failed') {
      throw new Error('Fiber payment returned an unsupported status.');
    }
    const returnedHash = typeof result.payment_hash === 'string' ? result.payment_hash.toLowerCase() : paymentHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(returnedHash)) {
      throw new Error('Fiber payment returned an invalid payment hash.');
    }
    if (returnedHash !== paymentHash.toLowerCase()) {
      throw new Error('Fiber payment response does not match the requested payment hash.');
    }
    return {
      provider: this.kind,
      network: this.network,
      paymentHash: returnedHash,
      status,
      failure: typeof result.failed_error === 'string' ? result.failed_error : undefined,
      raw
    };
  }

  async authorizeCharge(input: FiberAuthorizeChargeInput): Promise<FiberChargeResult> {
    const keysendTargetPubkey = typeof input.metadata?.fiberKeysendTargetPubkey === 'string'
      ? input.metadata.fiberKeysendTargetPubkey.trim()
      : '';
    if (keysendTargetPubkey) {
      const raw = await this.rpc('send_payment', [{
        target_pubkey: keysendTargetPubkey,
        amount: fiberRpcHexQuantity(input.amountMinor),
        keysend: true,
        ...(typeof input.metadata?.fiberPaymentTimeoutSeconds === 'number' ? { timeout: fiberRpcHexQuantity(input.metadata.fiberPaymentTimeoutSeconds) } : {}),
        ...(typeof input.metadata?.fiberMaxFeeAmountMinor === 'number' ? { max_fee_amount: fiberRpcHexQuantity(input.metadata.fiberMaxFeeAmountMinor) } : {})
      }]);
      return {
        provider: this.kind,
        network: this.network,
        authorized: true,
        proofId: String((raw as { payment_hash?: unknown })?.payment_hash ?? (raw as { hash?: unknown })?.hash ?? (raw as { payment_preimage?: unknown })?.payment_preimage ?? ''),
        status: this.successfulPaymentStatus(raw),
        raw
      };
    }

    const invoice = input.paymentRequest ?? (typeof input.metadata?.fiberInvoice === 'string' ? input.metadata.fiberInvoice : '');
    if (!invoice) {
      throw new Error('A Fiber invoice/payment request is required for Fiber charges.');
    }

    const raw = await this.rpc('send_payment', [{
      invoice,
      ...(input.metadata?.fiberAllowSelfPayment === true ? { allow_self_payment: true } : {}),
      ...(typeof input.metadata?.fiberPaymentTimeoutSeconds === 'number' ? { timeout: fiberRpcHexQuantity(input.metadata.fiberPaymentTimeoutSeconds) } : {}),
      ...(typeof input.metadata?.fiberMaxFeeAmountMinor === 'number' ? { max_fee_amount: fiberRpcHexQuantity(input.metadata.fiberMaxFeeAmountMinor) } : {})
    }]);
    return {
      provider: this.kind,
      network: this.network,
      authorized: true,
      proofId: String((raw as { payment_hash?: unknown })?.payment_hash ?? (raw as { hash?: unknown })?.hash ?? ''),
      status: this.successfulPaymentStatus(raw),
      raw
    };
  }

  async topUpSession(input: FiberTopUpInput): Promise<FiberTopUpResult> {
    if (!input.networkSessionId) {
      throw new Error('networkSessionId is required to top up a Fiber session.');
    }
    const raw = await this.rpc('add_tlc', [{
      channel_id: input.networkSessionId,
      amount: input.amountMinor.toString()
    }]);
    return { provider: this.kind, network: this.network, proofId: String((raw as { id?: unknown })?.id ?? ''), raw };
  }

  async revokeSession(input: FiberSettleInput): Promise<FiberSettleResult> {
    return this.shutdown(input, 'revoked');
  }

  async settleSession(input: FiberSettleInput): Promise<FiberSettleResult> {
    return this.shutdown(input, input.reason);
  }

  async getStatus(sessionId: string, networkSessionId?: string): Promise<FiberStatusResult> {
    const raw = networkSessionId
      ? await this.rpc('channel', [{ channel_id: networkSessionId }])
      : await this.rpc('node_info', []);
    return {
      provider: this.kind,
      network: this.network,
      status: networkSessionId ? 'active' : 'pending',
      networkSessionId: networkSessionId ?? sessionId,
      raw
    };
  }

  private async shutdown(input: FiberSettleInput, reason: FiberSettlementReason): Promise<FiberSettleResult> {
    if (!input.networkSessionId) {
      throw new Error('networkSessionId is required to close a Fiber session.');
    }
    const raw = await this.rpc('shutdown_channel', [{ channel_id: input.networkSessionId, force: reason === 'revoked' }]);
    return {
      provider: this.kind,
      network: this.network,
      settled: true,
      proofId: String((raw as { tx_hash?: unknown })?.tx_hash ?? ''),
      raw
    };
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.FIBER_RPC_TIMEOUT_MS);
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(env.FIBER_API_KEY ? { Authorization: 'Bearer ' + env.FIBER_API_KEY } : {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: controller.signal
      });

      const payload = await response.json().catch(() => null) as { result?: unknown; error?: { code?: number; message?: string } } | null;
      if (!response.ok || payload?.error) {
        throw new Error(payload?.error?.message ?? 'Fiber RPC request failed: ' + method);
      }
      if (!payload || payload.result == null) {
        throw new Error('Fiber RPC returned no result: ' + method);
      }
      return payload.result;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('Fiber RPC request timed out: ' + method);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private successfulPaymentStatus(raw: unknown): 'Success' {
    const status = raw && typeof raw === 'object' ? (raw as { status?: unknown }).status : undefined;
    if (status !== 'Success') {
      const failedError = raw && typeof raw === 'object' ? (raw as { failed_error?: unknown }).failed_error : undefined;
      throw new Error(typeof failedError === 'string' && failedError ? failedError : 'Fiber payment did not reach Success status.');
    }
    return 'Success';
  }
}

export function createFiberProvider(): FiberProvider {
  return new RpcFiberProvider({ rpcUrl: env.FIBER_RPC_URL, network: env.FIBER_NETWORK });
}

export const fiberProvider = createFiberProvider();
