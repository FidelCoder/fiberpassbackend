import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { toMinorUnits, fromMinorUnits } from '../lib/money.js';
import { writeAuditLog } from './audit.service.js';
import { fiberProvider } from './fiberProvider.js';
import { getFiberNodeReadiness } from './fiberNode.service.js';

export interface FiberPeerTargetDto {
  peerId: string;
  source: 'env' | 'primary';
  primary: boolean;
}

export interface FiberChannelStrategyDto {
  network: string;
  provider: string;
  readyForLiveTest: boolean;
  configuredPrimaryPeer?: string;
  targetPeers: FiberPeerTargetDto[];
  testChannelAmount: number;
  testChannelAmountMinor: number;
  readiness: Awaited<ReturnType<typeof getFiberNodeReadiness>>;
  nextActions: string[];
}

export interface FiberChannelOpenResultDto {
  ok: true;
  localSessionId: string;
  peerId: string;
  amount: number;
  amountMinor: number;
  networkSessionId: string;
  status: string;
  proofId?: string;
  raw?: unknown;
}

function targetPeerIds(): string[] {
  const values = [env.FIBER_PEER_ID, ...env.FIBER_TARGET_PEER_IDS.split(',')]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function channelAmountMinor(amount?: number): number {
  const value = amount ?? env.FIBER_TEST_CHANNEL_AMOUNT_CKB;
  return toMinorUnits(String(value), 'CKB');
}

export async function getFiberChannelStrategy(): Promise<FiberChannelStrategyDto> {
  const readiness = await getFiberNodeReadiness();
  const peers = targetPeerIds();
  const targetPeers = peers.map((peerId, index) => ({
    peerId,
    source: index === 0 && peerId === env.FIBER_PEER_ID ? 'primary' as const : 'env' as const,
    primary: index === 0
  }));
  const testChannelAmountMinor = channelAmountMinor();
  const nextActions: string[] = [];

  if (!readiness.reachable) nextActions.push('Restore Fiber RPC reachability before channel tests.');
  if (targetPeers.length === 0) nextActions.push('Set FIBER_PEER_ID or FIBER_TARGET_PEER_IDS with a reachable testnet peer.');
  if (readiness.peers.status === 'available' && (readiness.peers.connectedCount ?? 0) === 0) nextActions.push('Connect the node to at least one Fiber peer.');
  if (readiness.channels.status === 'available' && (readiness.channels.activeCount ?? 0) === 0) nextActions.push('Open a test channel before live invoice payment validation.');
  if (readiness.paymentExecution.status === 'unknown') nextActions.push('Confirm peer/channel state manually with node logs or fnn-cli because this RPC does not expose full probes.');
  if (nextActions.length === 0) nextActions.push('Run a live Fiber invoice payment test with a real payment request.');

  return {
    network: env.FIBER_NETWORK,
    provider: fiberProvider.kind,
    readyForLiveTest: readiness.paymentExecution.status === 'ready' && targetPeers.length > 0,
    configuredPrimaryPeer: env.FIBER_PEER_ID || undefined,
    targetPeers,
    testChannelAmount: fromMinorUnits(testChannelAmountMinor, 'CKB'),
    testChannelAmountMinor,
    readiness,
    nextActions
  };
}

export async function openFiberTestChannel(input: { peerId?: string; amount?: number; actorWalletId?: string } = {}): Promise<FiberChannelOpenResultDto> {
  const peerId = input.peerId?.trim() || env.FIBER_PEER_ID;
  if (!peerId) {
    throw new ApiError(400, 'FIBER_PEER_ID_REQUIRED', 'Set FIBER_PEER_ID or provide a peer id before opening a Fiber test channel.');
  }

  const amountMinor = channelAmountMinor(input.amount);
  if (amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_CHANNEL_AMOUNT', 'Fiber channel amount must be greater than zero.');
  }

  const localSessionId = 'fp_channel_test_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const result = await fiberProvider.createSession({
    localSessionId,
    walletId: input.actorWalletId ?? 'fiberpass-operator',
    appAddress: 'fiberpass-channel-test',
    amountMinor,
    currency: 'CKB',
    metadata: { fiberPeerId: peerId, purpose: 'channel_test' }
  });

  await writeAuditLog({
    actorWalletId: input.actorWalletId,
    action: 'fiber.channel_test_opened',
    targetType: 'fiber_channel',
    targetId: result.networkSessionId,
    metadata: { peerId, amountMinor, proofId: result.proofId }
  });

  return {
    ok: true,
    localSessionId,
    peerId,
    amount: fromMinorUnits(amountMinor, 'CKB'),
    amountMinor,
    networkSessionId: result.networkSessionId,
    status: result.status,
    proofId: result.proofId,
    raw: result.raw
  };
}
