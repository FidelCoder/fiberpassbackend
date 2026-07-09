# FiberPass Backend

Node.js + TypeScript API for prepaid, revocable Fiber payment sessions.

## Stack

- Express API
- MongoDB + Mongoose
- JoyID challenge-response auth
- Server-Sent Events for live dashboard updates
- Integer minor-unit accounting for money values
- Fiber Network JSON-RPC provider only
- Rate limiting, audit logs, request IDs, and production env validation

## Run Locally

```bash
cp .env.example .env
docker compose up -d mongo
npm install
npm run dev
```

API runs on `http://localhost:4000` by default. A real Fiber RPC URL is required through `FIBER_RPC_URL`; the backend exposes only product endpoints backed by the configured Fiber RPC provider.

## Fiber Provider

`FIBER_PROVIDER=rpc` is the only supported provider. Configure `FIBER_RPC_URL`, `FIBER_PEER_ID`, and optional `FIBER_API_KEY` for your Fiber node. Configure `FIBERPASS_VAULT_CODE_HASH`, `FIBERPASS_VAULT_HASH_TYPE`, and `FIBERPASS_OPERATOR_LOCK_HASH` after deploying the vault lock script so funding requests derive per-user vault addresses. `FIBERPASS_TREASURY_ADDRESS` remains a temporary fallback while vault deployment is not configured.

See `docs/fiber-network-spike.md` for integration notes.

## Lock Scripts

Vault lock-script drafts live in `lockscripts/`. The current `fiberpass-vault-lock` draft models testnet user vault cells with per-user lock args so funding records stay distinct across users. Use `npm run vault:build` and `npm run vault:deploy:testnet` after funding the local deployer wallet. Testnet deployment details are recorded in `docs/vault-testnet-deployment.md`.

## Core Endpoints

All product endpoints are available at their current paths and under `/v1` aliases.

- `GET /health`
- `GET /meta`
- `POST /auth/challenge`
- `POST /auth/verify`
- `GET /auth/me`
- `POST /auth/logout`
- `GET /wallet/funding`
- `POST /wallet/funding`
- `POST /wallet/funding/sync`
- `POST /wallet/funding/:fundingId/confirm`
- `GET /sessions/create-policy`
- `GET /sessions`
- `GET /events`
- `POST /sessions`
- `POST /sessions/:id/top-up`
- `POST /sessions/:id/toggle-pause`
- `POST /sessions/:id/revoke`
- `POST /sessions/:id/settle`
- `GET /apps`
- `POST /apps`
- `POST /apps/:appId/api-keys`
- `POST /apps/:appId/api-keys/:keyId/revoke`
- `GET /apps/:appId/charges`
- `POST /apps/:appId/charges`

## Checks

```bash
npm run build
npm test
```
