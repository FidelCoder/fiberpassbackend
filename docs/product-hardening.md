# FiberPass Product Hardening

This file tracks the operational polish required for beta.

## User Product Rules

- Dashboard shows only the connected user's FiberPass available balance, active pass limits, and active sessions.
- Infrastructure status belongs in Settings, not Dashboard.
- History items must open full pass details, including recipients, attempts, receipts, and transaction links.
- Recipient emails must include payer name, pass name, expected payment time, expiry time, amount, and claim link.
- Successful payouts must send receipt emails with transaction hash and explorer link.

## Money Movement Rules

- Vault liquidity is the user-funded settlement source.
- Fiber node is infrastructure for Fiber rail execution, not the user balance source.
- Ledger updates must reconcile against vault cells after successful payouts.
- Failed or stale attempts need visible failure reasons and retry/release handling.

## Monitoring Checklist

- Backend health endpoint is reachable.
- Fiber node readiness has no critical alerts.
- Payment worker is running.
- Webhook worker is running if app webhooks are enabled.
- Reconciliation worker is running.
- MongoDB writes and indexes are healthy.
- SMTP sends invite and receipt emails.
- Explorer links resolve for payout transactions.

## Regression Coverage

Keep tests around:

- wallet/vault balance reconciliation
- idempotent charge attempts
- app permissions and scope enforcement
- Fiber payment request requirement
- direct vault scheduled payouts
- stale job reconciliation
- daily/session limits
