# Fiber Node Deployment

FiberPass needs a public Fiber RPC endpoint for real Fiber channel/payment operations. Vercel cannot host a long-running P2P node, so run the node on a VPS with Docker and point the Vercel backend to its authenticated HTTPS gateway.

Official Fiber Docker images are published as `nervos/fiber` and `ghcr.io/nervosnetwork/fiber`. The bundled Fiber RPC config binds to `127.0.0.1:8227`, so this deployment renders a testnet config that keeps RPC private inside Docker and exposes only a token-protected Caddy HTTPS gateway.

## Server Requirements

- Ubuntu VPS or equivalent
- Docker Engine and Docker Compose plugin
- Public domain, for example `fiber-rpc.example.com`
- DNS `A` record pointing that domain to the VPS public IP
- Open ports `80`, `443`, and `8228/tcp`
- Do not expose `8227` publicly

## Deploy

```bash
cd infra/fiber-node
cp .env.example .env
```

Edit `.env`:

```bash
FIBER_SECRET_KEY_PASSWORD=long-private-node-password
FIBER_RPC_PROXY_TOKEN=long-random-token-used-by-backend
FIBER_RPC_DOMAIN=fiber-rpc.example.com
FIBER_PUBLIC_MULTIADDR=/ip4/YOUR_SERVER_PUBLIC_IP/tcp/8228
FIBER_ANNOUNCED_NODE_NAME=FiberPass Testnet Node
CKB_TESTNET_RPC_URL=https://testnet.ckb.dev/
```

Create the Fiber node CKB key file on the VPS:

```bash
mkdir -p data/ckb
nano data/ckb/key
chmod 600 data/ckb/key
```

Fund that key with testnet CKB for Fiber channel operations.

Render the Fiber config and start the node:

```bash
node render-config.mjs
docker compose pull
docker compose up -d
```

Check the node:

```bash
docker compose logs -f fiber-node
docker compose exec fiber-node fnn-cli info
```

Check the protected public RPC:

```bash
curl https://fiber-rpc.example.com \
  -H "Authorization: Bearer YOUR_FIBER_RPC_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"node_info","params":[]}'
```

## Backend Production Env

Set these on the Vercel backend project after the node is live:

```bash
FIBER_RPC_URL=https://fiber-rpc.example.com
FIBER_API_KEY=YOUR_FIBER_RPC_PROXY_TOKEN
FIBER_PEER_ID=<peer id from fnn-cli info when needed for open_channel>
```

Then redeploy the backend.

Vault funding and bridge transactions continue using `CKB_TESTNET_RPC_URL=https://testnet.ckb.dev`. Fiber RPC is needed for channel operations such as opening channels, sending Fiber invoices, and checking Fiber node state.

## Vercel Deployment Shape

Vercel should host the FiberPass API only. It should not host the Fiber node itself.

Reason: a Fiber node is a long-running P2P process with persistent state, TCP peer connectivity, local keys, and a private RPC listener. Vercel functions are request-scoped application functions, so they can call a Fiber RPC endpoint but should not be treated as the node runtime.

Correct production shape:

```txt
FiberPass frontend on Vercel
        |
FiberPass backend on Vercel
        |
HTTPS + bearer token
        |
Fiber RPC gateway on VPS
        |
Fiber node Docker container on VPS
        |
CKB testnet RPC / Fiber peers
```

Vercel backend env should point to the VPS gateway:

```bash
FIBER_RPC_URL=https://fiber-rpc.example.com
FIBER_API_KEY=YOUR_FIBER_RPC_PROXY_TOKEN
FIBER_PEER_ID=<peer id used for open_channel>
```

After deployment, check:

```bash
curl https://fiberpassbackend.vercel.app/fiber/node/status
```

FiberPass scheduled payouts are Fiber-only in the product flow. The node is required for live channel/app payment operations, while the vault lock remains the source of user liquidity.
