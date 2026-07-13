# Fiber Node Readiness

FiberPass treats the Fiber node as operator infrastructure. User balances are not read from the node wallet. User balances come from the per-wallet vault ledger.

## Endpoints

- `GET /fiber/node/status`
- `GET /fiber/node/readiness`

Both endpoints return the same backend readiness object.

## Readiness Fields

- `reachable`: `node_info` worked against the configured Fiber RPC URL.
- `paymentExecution.status`: `ready`, `blocked`, or `unknown`.
- `alerts`: operator-facing issues that explain why Fiber app/API payments may fail.
- `peers`: peer probe summary when the RPC exposes a supported peer listing method.
- `channels`: channel and outbound liquidity summary when the RPC exposes a supported channel listing method.
- `operator.liquiditySource`: always `fiber-node-operator`; it is not a user wallet or user balance.

## Alert Codes

- `NODE_RPC_NOT_CONFIGURED`: backend has no Fiber RPC URL.
- `NODE_UNREACHABLE`: `node_info` failed.
- `NODE_PEER_ID_MISSING`: node did not report a peer id.
- `NODE_LISTEN_ADDRESS_MISSING`: node did not report listen or announced addresses.
- `CHANNEL_OPEN_NOT_CONFIGURED`: `FIBER_PEER_ID` is missing for channel-open tests.
- `NODE_NO_PEERS`: peer probe reported too few connected peers.
- `NODE_NO_ACTIVE_CHANNELS`: channel probe reported too few active channels.
- `NODE_LOW_OUTBOUND_LIQUIDITY`: active outbound channel liquidity is below threshold.
- `PAYMENT_ROUTE_UNAVAILABLE`: peers or active channels are missing.
- `PEER_STATUS_UNKNOWN` / `CHANNEL_STATUS_UNKNOWN`: this RPC build did not expose list methods, so use node logs or CLI to confirm manually.

## Threshold Env

- `FIBER_NODE_MIN_PEERS`, default `1`
- `FIBER_NODE_MIN_ACTIVE_CHANNELS`, default `1`
- `FIBER_NODE_MIN_OUTBOUND_LIQUIDITY_CKB`, default `0.01`

These thresholds are for operator readiness only. They must not be shown as user funds in the dashboard.
