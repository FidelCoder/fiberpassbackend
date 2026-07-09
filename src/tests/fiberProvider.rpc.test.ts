import assert from 'node:assert/strict';

process.env.FIBER_RPC_URL = process.env.FIBER_RPC_URL || 'http://127.0.0.1:8227';
process.env.FIBER_PROVIDER = 'rpc';

const { RpcFiberProvider } = await import('../services/fiberProvider.js');

const provider = new RpcFiberProvider({ rpcUrl: process.env.FIBER_RPC_URL, network: 'testnet' });
assert.equal(provider.kind, 'rpc');
assert.equal(provider.network, 'testnet');
await assert.rejects(
  () => provider.createSession({
    localSessionId: 'session-1',
    walletId: 'wallet-1',
    appAddress: 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl',
    amountMinor: 100_000_000,
    currency: 'CKB'
  }),
  /FIBER_PEER_ID/
);
