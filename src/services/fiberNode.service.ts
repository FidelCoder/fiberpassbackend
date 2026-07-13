import { config, helpers, type Script } from '@ckb-lumos/lumos';
import { env } from '../config/env.js';
import { fromMinorUnits, toMinorUnits } from '../lib/money.js';
import { fiberProvider } from './fiberProvider.js';

export type FiberNodeProbeStatus = 'available' | 'unavailable' | 'error';
export type FiberNodeAlertSeverity = 'info' | 'warning' | 'critical';
export type FiberNodePaymentExecutionStatus = 'ready' | 'blocked' | 'unknown';

export interface FiberNodeAlertDto {
  code: string;
  severity: FiberNodeAlertSeverity;
  message: string;
  action: string;
}

export interface FiberNodePeerSummaryDto {
  status: FiberNodeProbeStatus;
  method: string;
  connectedCount?: number;
  peers?: Array<{ peerId?: string; address?: string; connected?: boolean }>;
  error?: string;
}

export interface FiberNodeChannelSummaryDto {
  status: FiberNodeProbeStatus;
  method: string;
  count?: number;
  activeCount?: number;
  totalOutboundCapacityMinor?: number;
  totalOutboundCapacity?: number;
  minOutboundCapacityMinor?: number;
  minOutboundCapacity?: number;
  channels?: Array<{
    channelId?: string;
    peerId?: string;
    status?: string;
    outboundCapacityMinor?: number;
    outboundCapacity?: number;
  }>;
  error?: string;
}

export interface FiberNodePaymentExecutionDto {
  status: FiberNodePaymentExecutionStatus;
  canSendPayments: boolean;
  reason: string;
}

export interface FiberNodeReadinessDto {
  configured: boolean;
  reachable: boolean;
  provider: string;
  network: string;
  rpcUrl: string;
  apiKeyConfigured: boolean;
  peerIdConfigured: boolean;
  checkedAt: string;
  latencyMs?: number;
  readiness: FiberNodePaymentExecutionStatus;
  paymentExecution: FiberNodePaymentExecutionDto;
  operator: {
    liquiditySource: 'fiber-node-operator';
    minPeers: number;
    minActiveChannels: number;
    minOutboundCapacityMinor: number;
    minOutboundCapacity: number;
  };
  alerts: FiberNodeAlertDto[];
  peers: FiberNodePeerSummaryDto;
  channels: FiberNodeChannelSummaryDto;
  node?: {
    peerId?: string;
    version?: string;
    chain?: string;
    addresses?: string[];
    fundingAddress?: string;
    fundingLock?: Script;
    rawKeys: string[];
  };
  error?: string;
}

type RpcScript = { code_hash?: unknown; codeHash?: unknown; hash_type?: unknown; hashType?: unknown; args?: unknown };
type RpcProbeResult = { status: FiberNodeProbeStatus; method: string; raw?: unknown; error?: string; code?: number };

type FiberNodeReadinessInput = {
  configured: boolean;
  reachable: boolean;
  peerIdConfigured: boolean;
  node?: FiberNodeReadinessDto['node'];
  peers: FiberNodePeerSummaryDto;
  channels: FiberNodeChannelSummaryDto;
  minPeers: number;
  minActiveChannels: number;
  minOutboundCapacityMinor: number;
  error?: string;
};

const PEER_METHODS = ['list_peers', 'peers', 'connected_peers'];
const CHANNEL_METHODS = ['list_channels', 'channels'];
const DEFAULT_PARAM_VARIANTS: unknown[][] = [[]];
const CHANNEL_PARAM_VARIANTS: unknown[][] = [[], [{}], [{ limit: 100 }], [{ limit: '0x64' }]];
const ACTIVE_CHANNEL_STATUSES = new Set(['active', 'open', 'opened', 'normal', 'ready', 'channel_ready', 'usable']);
const OUTBOUND_CAPACITY_KEYS = [
  'outbound_capacity',
  'outboundCapacity',
  'available_balance',
  'availableBalance',
  'spendable_balance',
  'spendableBalance',
  'local_balance',
  'localBalance',
  'local_amount',
  'localAmount',
  'balance'
];

function networkConfig() {
  return env.FIBER_NETWORK.toLowerCase().includes('main') ? config.MAINNET : config.TESTNET;
}

function publicRpcUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol + '//' + url.host;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function pickStringArray(record: Record<string, unknown>, keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (items.length > 0) return items;
    }
    if (typeof value === 'string' && value.trim()) return [value];
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function normalizeScript(value: unknown): Script | undefined {
  const script = asRecord(value) as RpcScript;
  const codeHash = typeof script.code_hash === 'string' ? script.code_hash : typeof script.codeHash === 'string' ? script.codeHash : '';
  const hashType = typeof script.hash_type === 'string' ? script.hash_type : typeof script.hashType === 'string' ? script.hashType : '';
  const args = typeof script.args === 'string' ? script.args : '';

  if (!codeHash || !hashType || !args) return undefined;
  if (!['data', 'type', 'data1', 'data2'].includes(hashType)) return undefined;

  return { codeHash, hashType: hashType as Script['hashType'], args };
}

function fundingAddressFromNodeInfo(raw: Record<string, unknown>): { fundingAddress?: string; fundingLock?: Script } {
  const fundingLock = normalizeScript(raw.default_funding_lock_script ?? raw.defaultFundingLockScript);
  if (!fundingLock) return {};

  try {
    return {
      fundingLock,
      fundingAddress: helpers.encodeToAddress(fundingLock, { config: networkConfig() })
    };
  } catch {
    return { fundingLock };
  }
}

function arrayFromPayload(raw: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  const record = asRecord(raw);
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

function peerIdFromRecord(record: Record<string, unknown>): string | undefined {
  return pickString(record, ['peer_id', 'peerId', 'node_id', 'nodeId', 'pubkey', 'id']);
}

function isPeerConnected(record: Record<string, unknown>): boolean | undefined {
  const value = record.connected ?? record.is_connected ?? record.isConnected ?? record.status;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['connected', 'active', 'online', 'true'].includes(normalized)) return true;
    if (['disconnected', 'inactive', 'offline', 'false'].includes(normalized)) return false;
  }
  return undefined;
}

function channelStatus(record: Record<string, unknown>): string | undefined {
  return pickString(record, ['status', 'state', 'channel_status', 'channelStatus']);
}

function isActiveChannel(status?: string): boolean {
  if (!status) return true;
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ACTIVE_CHANNEL_STATUSES.has(normalized) || normalized.includes('active') || normalized.includes('ready');
}

function outboundCapacityMinor(record: Record<string, unknown>): number | undefined {
  const amount = pickNumber(record, OUTBOUND_CAPACITY_KEYS);
  if (amount == null || amount < 0) return undefined;
  return Math.floor(amount);
}

function rpcErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Fiber RPC probe failed.';
}

function rpcErrorCode(error: unknown): number | undefined {
  return typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined;
}

function isMethodUnavailable(error: unknown): boolean {
  const code = rpcErrorCode(error);
  if (code === -32601) return true;
  return /method\s+not\s+found|unknown\s+method|not\s+supported|unsupported/i.test(rpcErrorMessage(error));
}

async function callFiberRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(env.FIBER_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.FIBER_API_KEY ? { Authorization: 'Bearer ' + env.FIBER_API_KEY } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });

  const payload = await response.json().catch(() => null) as { result?: unknown; error?: { code?: number; message?: string } } | null;
  if (!response.ok || payload?.error) {
    const error = new Error(payload?.error?.message ?? 'Fiber RPC request failed: ' + method) as Error & { code?: number };
    error.code = payload?.error?.code;
    throw error;
  }
  return payload?.result;
}

async function probeFiberRpcMethods(methods: string[], paramVariants = DEFAULT_PARAM_VARIANTS): Promise<RpcProbeResult> {
  const unavailable: string[] = [];
  let lastParamError: { method: string; error: string; code?: number } | undefined;

  for (const method of methods) {
    for (const params of paramVariants) {
      try {
        return { status: 'available', method, raw: await callFiberRpc(method, params) };
      } catch (error) {
        if (isMethodUnavailable(error)) {
          unavailable.push(method);
          break;
        }

        const code = rpcErrorCode(error);
        const message = rpcErrorMessage(error);
        if (code === -32602 || /invalid params/i.test(message)) {
          lastParamError = { method, error: message, code };
          continue;
        }
        return { status: 'error', method, error: message, code };
      }
    }
  }

  if (lastParamError) {
    return { status: 'error', method: lastParamError.method, error: lastParamError.error, code: lastParamError.code };
  }

  return {
    status: 'unavailable',
    method: methods.join('|'),
    error: 'Fiber RPC did not expose any of these methods: ' + unavailable.join(', ')
  };
}

export function summarizeFiberNodePeers(probe: RpcProbeResult): FiberNodePeerSummaryDto {
  if (probe.status !== 'available') {
    return { status: probe.status, method: probe.method, error: probe.error };
  }

  const items = arrayFromPayload(probe.raw, ['peers', 'connected_peers', 'connectedPeers', 'nodes']) ?? [];
  const peers = items
    .map((item) => asRecord(item))
    .map((record) => ({
      peerId: peerIdFromRecord(record),
      address: pickString(record, ['address', 'addr', 'multiaddr', 'multiAddr']),
      connected: isPeerConnected(record)
    }));
  const countFromPayload = pickNumber(asRecord(probe.raw), ['connected_count', 'connectedCount', 'peer_count', 'peerCount', 'count']);
  const connectedCount = countFromPayload ?? peers.filter((peer) => peer.connected !== false).length;

  return {
    status: 'available',
    method: probe.method,
    connectedCount,
    peers: peers.slice(0, 20)
  };
}

export function summarizeFiberNodeChannels(probe: RpcProbeResult): FiberNodeChannelSummaryDto {
  if (probe.status !== 'available') {
    return { status: probe.status, method: probe.method, error: probe.error };
  }

  const items = arrayFromPayload(probe.raw, ['channels', 'items', 'data']) ?? [];
  const channels = items
    .map((item) => asRecord(item))
    .map((record) => {
      const status = channelStatus(record);
      const outboundCapacityMinorValue = outboundCapacityMinor(record);
      return {
        channelId: pickString(record, ['channel_id', 'channelId', 'id']),
        peerId: pickString(record, ['peer_id', 'peerId', 'remote_peer_id', 'remotePeerId']),
        status,
        outboundCapacityMinor: outboundCapacityMinorValue,
        outboundCapacity: outboundCapacityMinorValue == null ? undefined : fromMinorUnits(outboundCapacityMinorValue, 'CKB')
      };
    });
  const activeChannels = channels.filter((channel) => isActiveChannel(channel.status));
  const knownOutboundCapacities = activeChannels
    .map((channel) => channel.outboundCapacityMinor)
    .filter((value): value is number => value != null);
  const totalOutboundCapacityMinor = knownOutboundCapacities.length > 0
    ? knownOutboundCapacities.reduce((sum, value) => sum + value, 0)
    : undefined;
  const minOutboundCapacityMinor = knownOutboundCapacities.length > 0 ? Math.min(...knownOutboundCapacities) : undefined;

  return {
    status: 'available',
    method: probe.method,
    count: channels.length,
    activeCount: activeChannels.length,
    totalOutboundCapacityMinor,
    totalOutboundCapacity: totalOutboundCapacityMinor == null ? undefined : fromMinorUnits(totalOutboundCapacityMinor, 'CKB'),
    minOutboundCapacityMinor,
    minOutboundCapacity: minOutboundCapacityMinor == null ? undefined : fromMinorUnits(minOutboundCapacityMinor, 'CKB'),
    channels: channels.slice(0, 20)
  };
}

function alert(code: string, severity: FiberNodeAlertSeverity, message: string, action: string): FiberNodeAlertDto {
  return { code, severity, message, action };
}

export function buildFiberNodeAlerts(input: FiberNodeReadinessInput): FiberNodeAlertDto[] {
  const alerts: FiberNodeAlertDto[] = [];

  if (!input.configured) {
    alerts.push(alert('NODE_RPC_NOT_CONFIGURED', 'critical', 'Fiber RPC URL is not configured.', 'Set FIBER_RPC_URL to the reachable Railway Fiber node RPC endpoint.'));
  }

  if (!input.reachable) {
    alerts.push(alert('NODE_UNREACHABLE', 'critical', input.error ?? 'Fiber RPC node_info is unreachable.', 'Check the Fiber node process, Railway service, RPC URL, and API token.'));
    return alerts;
  }

  if (!input.node?.peerId) {
    alerts.push(alert('NODE_PEER_ID_MISSING', 'warning', 'Fiber node did not report a peer id.', 'Confirm node_info returns peer identity and the node completed startup.'));
  }

  if (!input.node?.addresses || input.node.addresses.length === 0) {
    alerts.push(alert('NODE_LISTEN_ADDRESS_MISSING', 'warning', 'Fiber node did not report listen or announced addresses.', 'Confirm the node has a public TCP address and Railway proxy configuration.'));
  }

  if (!input.peerIdConfigured) {
    alerts.push(alert('CHANNEL_OPEN_NOT_CONFIGURED', 'warning', 'FIBER_PEER_ID is not configured for channel-open tests.', 'Set FIBER_PEER_ID when we are ready to open channels to a known testnet peer.'));
  }

  if (input.peers.status === 'available') {
    const connectedCount = input.peers.connectedCount ?? 0;
    if (connectedCount < input.minPeers) {
      alerts.push(alert('NODE_NO_PEERS', 'critical', 'Fiber node has ' + connectedCount + ' connected peers.', 'Connect the node to at least ' + input.minPeers + ' reachable Fiber testnet peer.'));
    }
  } else if (input.peers.status === 'unavailable') {
    alerts.push(alert('PEER_STATUS_UNKNOWN', 'warning', 'Fiber RPC did not expose a peer listing method.', 'Keep node_info healthy and use node logs or fnn-cli to confirm peer connectivity.'));
  } else {
    alerts.push(alert('PEER_STATUS_ERROR', 'warning', input.peers.error ?? 'Fiber peer status probe failed.', 'Check Fiber RPC permissions and method compatibility.'));
  }

  if (input.channels.status === 'available') {
    const activeCount = input.channels.activeCount ?? 0;
    if (activeCount < input.minActiveChannels) {
      alerts.push(alert('NODE_NO_ACTIVE_CHANNELS', 'critical', 'Fiber node has ' + activeCount + ' active channels.', 'Open or restore at least ' + input.minActiveChannels + ' channel before testing Fiber payments.'));
    }

    if (input.channels.totalOutboundCapacityMinor != null && input.channels.totalOutboundCapacityMinor < input.minOutboundCapacityMinor) {
      alerts.push(alert('NODE_LOW_OUTBOUND_LIQUIDITY', 'warning', 'Fiber node outbound channel liquidity is below the configured threshold.', 'Add operator liquidity to channels or lower FIBER_NODE_MIN_OUTBOUND_LIQUIDITY_CKB for test-only runs.'));
    }
  } else if (input.channels.status === 'unavailable') {
    alerts.push(alert('CHANNEL_STATUS_UNKNOWN', 'warning', 'Fiber RPC did not expose a channel listing method.', 'Use fnn-cli or node logs to confirm channel status until this RPC is available.'));
  } else {
    alerts.push(alert('CHANNEL_STATUS_ERROR', 'warning', input.channels.error ?? 'Fiber channel status probe failed.', 'Check Fiber RPC permissions and method compatibility.'));
  }

  const hasPeerBlocker = input.peers.status === 'available' && (input.peers.connectedCount ?? 0) < input.minPeers;
  const hasChannelBlocker = input.channels.status === 'available' && (input.channels.activeCount ?? 0) < input.minActiveChannels;
  if (hasPeerBlocker || hasChannelBlocker) {
    alerts.push(alert('PAYMENT_ROUTE_UNAVAILABLE', 'critical', 'Fiber payment route is not ready for app/API payments.', 'Connect peers and open an active channel with enough outbound liquidity before live Fiber charge tests.'));
  }

  return alerts;
}

export function paymentExecutionFromAlerts(input: {
  reachable: boolean;
  peers: FiberNodePeerSummaryDto;
  channels: FiberNodeChannelSummaryDto;
  alerts: FiberNodeAlertDto[];
}): FiberNodePaymentExecutionDto {
  if (!input.reachable || input.alerts.some((item) => item.severity === 'critical')) {
    return {
      status: 'blocked',
      canSendPayments: false,
      reason: 'Fiber node has critical readiness alerts that block payment execution.'
    };
  }

  if (input.peers.status !== 'available' || input.channels.status !== 'available') {
    return {
      status: 'unknown',
      canSendPayments: false,
      reason: 'Fiber node is reachable, but peer/channel liquidity could not be confirmed from RPC.'
    };
  }

  return {
    status: 'ready',
    canSendPayments: true,
    reason: 'Fiber node is reachable with peer and channel liquidity checks passing.'
  };
}

function operatorThresholds() {
  const minOutboundCapacityMinor = toMinorUnits(String(env.FIBER_NODE_MIN_OUTBOUND_LIQUIDITY_CKB), 'CKB');
  return {
    minPeers: env.FIBER_NODE_MIN_PEERS,
    minActiveChannels: env.FIBER_NODE_MIN_ACTIVE_CHANNELS,
    minOutboundCapacityMinor,
    minOutboundCapacity: fromMinorUnits(minOutboundCapacityMinor, 'CKB')
  };
}

function emptyPeerProbe(status: FiberNodeProbeStatus, method: string, error?: string): FiberNodePeerSummaryDto {
  return { status, method, error };
}

function emptyChannelProbe(status: FiberNodeProbeStatus, method: string, error?: string): FiberNodeChannelSummaryDto {
  return { status, method, error };
}

export async function getFiberNodeReadiness(): Promise<FiberNodeReadinessDto> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const thresholds = operatorThresholds();
  const base = {
    configured: Boolean(env.FIBER_RPC_URL),
    provider: env.FIBER_PROVIDER,
    network: env.FIBER_NETWORK,
    rpcUrl: publicRpcUrl(env.FIBER_RPC_URL),
    apiKeyConfigured: Boolean(env.FIBER_API_KEY),
    peerIdConfigured: Boolean(env.FIBER_PEER_ID),
    checkedAt,
    operator: {
      liquiditySource: 'fiber-node-operator' as const,
      ...thresholds
    }
  };

  if (!env.FIBER_RPC_URL) {
    const peers = emptyPeerProbe('unavailable', PEER_METHODS.join('|'), 'FIBER_RPC_URL is not configured.');
    const channels = emptyChannelProbe('unavailable', CHANNEL_METHODS.join('|'), 'FIBER_RPC_URL is not configured.');
    const alerts = buildFiberNodeAlerts({ ...base, reachable: false, peers, channels, minPeers: thresholds.minPeers, minActiveChannels: thresholds.minActiveChannels, minOutboundCapacityMinor: thresholds.minOutboundCapacityMinor, error: 'FIBER_RPC_URL is not configured.' });
    const paymentExecution = paymentExecutionFromAlerts({ reachable: false, peers, channels, alerts });
    return { ...base, reachable: false, readiness: paymentExecution.status, paymentExecution, alerts, peers, channels, error: 'FIBER_RPC_URL is not configured.' };
  }

  try {
    const status = await fiberProvider.getStatus('node_info');
    const raw = asRecord(status.raw);
    const funding = fundingAddressFromNodeInfo(raw);
    const node = {
      peerId: pickString(raw, ['peer_id', 'peerId', 'node_id', 'nodeId', 'pubkey']),
      version: pickString(raw, ['version', 'fiber_version', 'fiberVersion']),
      chain: pickString(raw, ['chain', 'network']),
      addresses: pickStringArray(raw, ['addresses', 'listen_addrs', 'listening_addrs', 'announced_addrs']),
      fundingAddress: funding.fundingAddress,
      fundingLock: funding.fundingLock,
      rawKeys: Object.keys(raw).sort()
    };

    const [peerProbe, channelProbe] = await Promise.all([
      probeFiberRpcMethods(PEER_METHODS),
      probeFiberRpcMethods(CHANNEL_METHODS, CHANNEL_PARAM_VARIANTS)
    ]);
    const peers = summarizeFiberNodePeers(peerProbe);
    const channels = summarizeFiberNodeChannels(channelProbe);
    const alerts = buildFiberNodeAlerts({
      ...base,
      reachable: true,
      node,
      peers,
      channels,
      minPeers: thresholds.minPeers,
      minActiveChannels: thresholds.minActiveChannels,
      minOutboundCapacityMinor: thresholds.minOutboundCapacityMinor
    });
    const paymentExecution = paymentExecutionFromAlerts({ reachable: true, peers, channels, alerts });

    return {
      ...base,
      reachable: true,
      readiness: paymentExecution.status,
      paymentExecution,
      alerts,
      peers,
      channels,
      latencyMs: Date.now() - startedAt,
      node
    };
  } catch (error) {
    const peers = emptyPeerProbe('unavailable', PEER_METHODS.join('|'), rpcErrorMessage(error));
    const channels = emptyChannelProbe('unavailable', CHANNEL_METHODS.join('|'), rpcErrorMessage(error));
    const errorMessage = rpcErrorMessage(error);
    const alerts = buildFiberNodeAlerts({ ...base, reachable: false, peers, channels, minPeers: thresholds.minPeers, minActiveChannels: thresholds.minActiveChannels, minOutboundCapacityMinor: thresholds.minOutboundCapacityMinor, error: errorMessage });
    const paymentExecution = paymentExecutionFromAlerts({ reachable: false, peers, channels, alerts });

    return {
      ...base,
      reachable: false,
      readiness: paymentExecution.status,
      paymentExecution,
      alerts,
      peers,
      channels,
      latencyMs: Date.now() - startedAt,
      error: errorMessage
    };
  }
}
