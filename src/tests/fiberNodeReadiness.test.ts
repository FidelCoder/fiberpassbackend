import assert from 'node:assert/strict';
import {
  buildFiberNodeAlerts,
  paymentExecutionFromAlerts,
  summarizeFiberNodeChannels,
  summarizeFiberNodePeers
} from '../services/fiberNode.service.js';

const peers = summarizeFiberNodePeers({
  status: 'available',
  method: 'list_peers',
  raw: {
    peers: [
      { peer_id: 'peer-a', address: '/ip4/127.0.0.1/tcp/8228', connected: true },
      { peer_id: 'peer-b', connected: false }
    ]
  }
});
assert.equal(peers.status, 'available');
assert.equal(peers.connectedCount, 1);
assert.equal(peers.peers?.[0]?.peerId, 'peer-a');

const channels = summarizeFiberNodeChannels({
  status: 'available',
  method: 'list_channels',
  raw: {
    channels: [
      { channel_id: 'channel-a', peer_id: 'peer-a', state: 'active', outbound_capacity: '5000000000' },
      { channel_id: 'channel-b', peer_id: 'peer-b', state: 'closed', outbound_capacity: '1000000000' }
    ]
  }
});
assert.equal(channels.status, 'available');
assert.equal(channels.count, 2);
assert.equal(channels.activeCount, 1);
assert.equal(channels.totalOutboundCapacityMinor, 5_000_000_000);
assert.equal(channels.totalOutboundCapacity, 50);

const healthyAlerts = buildFiberNodeAlerts({
  configured: true,
  reachable: true,
  peerIdConfigured: true,
  node: { peerId: 'node-a', addresses: ['/ip4/127.0.0.1/tcp/8228'], rawKeys: [] },
  peers,
  channels,
  minPeers: 1,
  minActiveChannels: 1,
  minOutboundCapacityMinor: 100_000_000
});
assert.equal(healthyAlerts.some((alert) => alert.severity === 'critical'), false);
assert.deepEqual(paymentExecutionFromAlerts({ reachable: true, peers, channels, alerts: healthyAlerts }), {
  status: 'ready',
  canSendPayments: true,
  reason: 'Fiber node is reachable with peer and channel liquidity checks passing.'
});

const noPeerAlerts = buildFiberNodeAlerts({
  configured: true,
  reachable: true,
  peerIdConfigured: false,
  node: { peerId: 'node-a', addresses: ['/ip4/127.0.0.1/tcp/8228'], rawKeys: [] },
  peers: { status: 'available', method: 'list_peers', connectedCount: 0, peers: [] },
  channels,
  minPeers: 1,
  minActiveChannels: 1,
  minOutboundCapacityMinor: 100_000_000
});
assert.ok(noPeerAlerts.some((alert) => alert.code === 'NODE_NO_PEERS'));
assert.ok(noPeerAlerts.some((alert) => alert.code === 'CHANNEL_OPEN_NOT_CONFIGURED'));
assert.equal(paymentExecutionFromAlerts({ reachable: true, peers: { status: 'available', method: 'list_peers', connectedCount: 0, peers: [] }, channels, alerts: noPeerAlerts }).status, 'blocked');

const unknownChannels = { status: 'unavailable' as const, method: 'list_channels|channels', error: 'method not found' };
const unknownAlerts = buildFiberNodeAlerts({
  configured: true,
  reachable: true,
  peerIdConfigured: true,
  node: { peerId: 'node-a', addresses: ['/ip4/127.0.0.1/tcp/8228'], rawKeys: [] },
  peers,
  channels: unknownChannels,
  minPeers: 1,
  minActiveChannels: 1,
  minOutboundCapacityMinor: 100_000_000
});
assert.ok(unknownAlerts.some((alert) => alert.code === 'CHANNEL_STATUS_UNKNOWN'));
assert.equal(paymentExecutionFromAlerts({ reachable: true, peers, channels: unknownChannels, alerts: unknownAlerts }).status, 'unknown');
