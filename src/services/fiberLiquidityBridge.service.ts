import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { fromMinorUnits } from '../lib/money.js';
import { SessionModel } from '../models/session.model.js';
import { writeAuditLog } from './audit.service.js';
import { getCkbTransaction } from './ckbChain.service.js';
import { openFiberTestChannel } from './fiberChannel.service.js';
import { getFiberNodeReadiness } from './fiberNode.service.js';
import { executeVaultLiquidityBridge } from './vaultPayout.service.js';

export interface FiberLiquidityBridgeInput {
  ownerWalletId: string;
  sessionId: string;
  recipientIndex: number;
  amountMinor: number;
  currency: string;
}

export interface FiberLiquidityBridgeReadyResult {
  ready: true;
  outboundCapacityMinor?: number;
}

type RecipientBridgeState = {
  fiberLiquidityBridgeTxHash?: string;
  fiberLiquidityBridgeAmountMinor?: number;
  fiberLiquidityBridgeStatus?: string;
  fiberLiquidityBridgeCreatedAt?: Date | string;
  fiberChannelOpenProofId?: string;
  fiberChannelOpenAmountMinor?: number;
  fiberChannelOpenRequestedAt?: Date | string;
};

const CHANNEL_OPEN_WAIT_MS = 10 * 60 * 1000;

function sufficientOutboundLiquidity(input: { activeCount?: number; totalOutboundCapacityMinor?: number; amountMinor: number }): boolean {
  if ((input.activeCount ?? 0) <= 0) return false;
  if (input.totalOutboundCapacityMinor == null) return true;
  return input.totalOutboundCapacityMinor >= input.amountMinor;
}

async function recipientBridgeState(sessionId: string, recipientIndex: number): Promise<RecipientBridgeState> {
  const session = await SessionModel.findOne({ publicId: sessionId }).select('recipientWallets').lean<{ recipientWallets?: RecipientBridgeState[] } | null>();
  return session?.recipientWallets?.[recipientIndex] ?? {};
}

async function setRecipientBridgeFields(sessionId: string, recipientIndex: number, fields: Record<string, unknown>): Promise<void> {
  const setFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    setFields['recipientWallets.' + recipientIndex + '.' + key] = value;
  }
  await SessionModel.updateOne({ publicId: sessionId }, { $set: setFields });
}

async function requireCommittedBridgeTransaction(txHash: string): Promise<void> {
  const tx = await getCkbTransaction(txHash).catch(() => null);
  if (tx?.tx_status.status !== 'committed') {
    throw new ApiError(409, 'FIBER_LIQUIDITY_BRIDGE_PENDING', 'Reserved vault liquidity has been sent to the Fiber node funding lock and is waiting for CKB confirmation. The payout worker will retry automatically.');
  }
}

function channelOpenStillFresh(requestedAt?: Date | string): boolean {
  if (!requestedAt) return false;
  const timestamp = new Date(requestedAt).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now() - CHANNEL_OPEN_WAIT_MS;
}

type PendingChannelOpenProbe = { hasOpenPending: boolean; failureDetail?: string };

function bridgeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bridgeString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function bridgeChannels(raw: unknown): Record<string, unknown>[] {
  const record = bridgeRecord(raw);
  const channels = Array.isArray(record.channels) ? record.channels : Array.isArray(raw) ? raw : [];
  return channels.map((channel) => bridgeRecord(channel));
}

function pendingChannelStateText(channel: Record<string, unknown>): string {
  const state = bridgeRecord(channel.state);
  return [
    bridgeString(state, ['state_name', 'stateName']),
    bridgeString(state, ['state_flags', 'stateFlags']),
    bridgeString(channel, ['failure_detail', 'failureDetail'])
  ].filter(Boolean).join(' ');
}

function isFailedPendingChannel(channel: Record<string, unknown>): boolean {
  const text = pendingChannelStateText(channel).toLowerCase();
  return text.includes('funding_aborted') || text.includes('failed') || text.includes('closed') || text.includes('aborted');
}

async function inspectPendingChannelOpen(): Promise<PendingChannelOpenProbe> {
  const response = await fetch(env.FIBER_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.FIBER_API_KEY ? { Authorization: 'Bearer ' + env.FIBER_API_KEY } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'list_channels', params: [{ only_pending: true }] })
  });

  const payload = await response.json().catch(() => null) as { result?: unknown; error?: { message?: string } } | null;
  if (!response.ok || payload?.error) return { hasOpenPending: true };

  const channels = bridgeChannels(payload?.result);
  if (channels.length === 0) return { hasOpenPending: false };

  const openPending = channels.filter((channel) => !isFailedPendingChannel(channel));
  if (openPending.length > 0) return { hasOpenPending: true };

  return {
    hasOpenPending: false,
    failureDetail: pendingChannelStateText(channels[0]) || 'Fiber channel funding attempt was aborted.'
  };
}


export async function ensureVaultFundedFiberLiquidity(input: FiberLiquidityBridgeInput): Promise<FiberLiquidityBridgeReadyResult> {
  const readiness = await getFiberNodeReadiness();
  if (!readiness.reachable) {
    throw new ApiError(503, 'FIBER_NODE_UNREACHABLE', 'Fiber node is not reachable, so vault liquidity cannot be routed through Fiber yet.');
  }

  if (sufficientOutboundLiquidity({
    activeCount: readiness.channels.activeCount,
    totalOutboundCapacityMinor: readiness.channels.totalOutboundCapacityMinor,
    amountMinor: input.amountMinor
  })) {
    return { ready: true, outboundCapacityMinor: readiness.channels.totalOutboundCapacityMinor };
  }

  const nodeFundingAddress = readiness.node?.fundingAddress;
  if (!nodeFundingAddress) {
    throw new ApiError(503, 'FIBER_NODE_FUNDING_ADDRESS_MISSING', 'Fiber node did not expose a funding address for vault-funded channel liquidity.');
  }

  const state = await recipientBridgeState(input.sessionId, input.recipientIndex);

  if (!state.fiberLiquidityBridgeTxHash) {
    const bridge = await executeVaultLiquidityBridge({
      ownerWalletId: input.ownerWalletId,
      sessionId: input.sessionId,
      nodeFundingAddress,
      amountMinor: input.amountMinor,
      currency: input.currency
    });

    await setRecipientBridgeFields(input.sessionId, input.recipientIndex, {
      fiberLiquidityBridgeTxHash: bridge.proofId,
      fiberLiquidityBridgeAmountMinor: input.amountMinor,
      fiberLiquidityBridgeStatus: 'pending_confirmation',
      fiberLiquidityBridgeCreatedAt: new Date()
    });
    await writeAuditLog({
      actorWalletId: input.ownerWalletId,
      action: 'fiber.liquidity_bridge_submitted',
      targetType: 'session',
      targetId: input.sessionId,
      metadata: { recipientIndex: input.recipientIndex, amountMinor: input.amountMinor, txHash: bridge.proofId, nodeFundingAddress }
    });

    throw new ApiError(409, 'FIBER_LIQUIDITY_BRIDGE_PENDING', 'Reserved vault funds were moved toward Fiber channel liquidity. Waiting for CKB confirmation before opening the channel.');
  }

  await requireCommittedBridgeTransaction(state.fiberLiquidityBridgeTxHash);
  if (state.fiberLiquidityBridgeStatus !== 'confirmed') {
    await setRecipientBridgeFields(input.sessionId, input.recipientIndex, { fiberLiquidityBridgeStatus: 'confirmed' });
  }

  const afterBridgeReadiness = await getFiberNodeReadiness();
  if (sufficientOutboundLiquidity({
    activeCount: afterBridgeReadiness.channels.activeCount,
    totalOutboundCapacityMinor: afterBridgeReadiness.channels.totalOutboundCapacityMinor,
    amountMinor: input.amountMinor
  })) {
    return { ready: true, outboundCapacityMinor: afterBridgeReadiness.channels.totalOutboundCapacityMinor };
  }

  if (state.fiberChannelOpenProofId && channelOpenStillFresh(state.fiberChannelOpenRequestedAt)) {
    const pendingOpen = await inspectPendingChannelOpen();
    if (pendingOpen.hasOpenPending) {
      throw new ApiError(409, 'FIBER_CHANNEL_OPEN_PENDING', 'Fiber channel open is already submitted and waiting to become active. The payout worker will retry automatically.');
    }
    await setRecipientBridgeFields(input.sessionId, input.recipientIndex, {
      fiberChannelOpenFailureDetail: pendingOpen.failureDetail,
      fiberChannelOpenFailedAt: new Date()
    });
  }

  try {
    const channel = await openFiberTestChannel({
      amount: fromMinorUnits(input.amountMinor, input.currency),
      actorWalletId: input.ownerWalletId
    });
    await setRecipientBridgeFields(input.sessionId, input.recipientIndex, {
      fiberChannelOpenProofId: channel.proofId,
      fiberChannelOpenAmountMinor: input.amountMinor,
      fiberChannelOpenRequestedAt: new Date()
    });
    await writeAuditLog({
      actorWalletId: input.ownerWalletId,
      action: 'fiber.vault_funded_channel_open_submitted',
      targetType: 'session',
      targetId: input.sessionId,
      metadata: { recipientIndex: input.recipientIndex, amountMinor: input.amountMinor, peerId: channel.peerId, channelId: channel.networkSessionId, proofId: channel.proofId }
    });
    throw new ApiError(409, 'FIBER_CHANNEL_OPEN_PENDING', 'Vault-funded Fiber channel open was submitted. Waiting for the channel to become active before sending payment.');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error && error.message ? error.message : 'Fiber channel open failed after vault liquidity bridge.';
    throw new ApiError(502, 'FIBER_CHANNEL_OPEN_FAILED', message);
  }
}
