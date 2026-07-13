# Fiber Channel Strategy And Live Test

FiberPass keeps customer funds in the vault ledger. Fiber channels are operator infrastructure for app/API and subscription payments.

## Read-Only Checks

- `GET /fiber/channels/strategy`
- `GET /fiber/node/readiness`

These return configured peer targets, readiness alerts, channel counts, and operator liquidity thresholds. They do not move funds.

## Operator Actions

These routes require `Authorization: Bearer <CRON_SECRET>`.

- `POST /fiber/channels/test-open`
- `POST /fiber/live-e2e`

`/fiber/channels/test-open` opens a small test channel with `FIBER_PEER_ID` or the provided peer id.

`/fiber/live-e2e` sends a real Fiber payment request through the configured node. It requires a real invoice/payment request and only proves the Fiber node payment path; product pass debiting is still handled by the app charge API.

## Required Env

- `FIBER_RPC_URL`
- `FIBER_API_KEY` when the RPC gateway requires it
- `FIBER_PEER_ID` for the primary channel peer
- `FIBER_TARGET_PEER_IDS` for additional comma-separated peers
- `FIBER_TEST_CHANNEL_AMOUNT_CKB`, default `0.01`
- `CRON_SECRET` for operator write actions
