# FiberPass Demo Readiness

Run the safe readiness check before a live demo:

```bash
npm run demo:readiness
```

Set `FIBERPASS_API_URL` to check a deployed backend:

```bash
FIBERPASS_API_URL=https://your-backend.example npm run demo:readiness
```

The readiness command checks:

- backend health
- backend metadata
- Fiber node readiness
- channel strategy
- configured target peers
- payment execution readiness

## Live Fiber Proof

A real Fiber payment proof needs all of these:

- reachable Fiber RPC node
- usable peer/channel
- real Fiber payment request/invoice
- `CRON_SECRET` available to the live test script

Run the live proof only when the payment request is available:

```bash
FIBERPASS_API_URL=https://your-backend.example \
CRON_SECRET=... \
npm run fiber:live-e2e -- '<fiber-payment-request>' 0.01
```

Do not run live proof against user funds unless the amount and recipient are intentional.
