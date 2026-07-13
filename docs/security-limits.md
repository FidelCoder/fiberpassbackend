# FiberPass Security And Limits

FiberPass uses server-side limits at the API and money-movement layers. Frontend validation is only a convenience; backend checks are the source of truth.

## Charge API Guardrails

- App charge calls are rate-limited by `RATE_LIMIT_APP_CHARGE_MAX` inside `RATE_LIMIT_WINDOW_MS`.
- Every app charge requires an idempotency key so retries cannot double-charge a pass.
- Charges are blocked when the pass is paused, revoked, closed, expired, settled, or over its remaining limit.
- Charges are blocked when the service app id or service address does not match the pass authorization.
- `FIBERPASS_DAILY_SESSION_SPEND_LIMIT_CKB` caps successful charge volume per pass per UTC day.
- Automation invoices and batches also use `AUTOMATION_MAX_INVOICE_CKB`, `AUTOMATION_MAX_BATCH_CKB`, and `AUTOMATION_DAILY_LIMIT_CKB`.

## Secret Rules

- Keep `FIBER_API_KEY`, `CRON_SECRET`, `FIBERPASS_OPERATOR_PRIVATE_KEY`, SMTP passwords, and MongoDB credentials server-side only.
- Never expose Fiber RPC credentials, vault signer keys, or cron/operator secrets to frontend env.
- Rotate secrets after demos, public recordings, screenshots, or accidental sharing.

## Operator Endpoints

The following endpoints require `Authorization: Bearer <CRON_SECRET>`:

- `POST /fiber/channels/test-open`
- `POST /fiber/live-e2e`

These are intentionally not user-facing product endpoints.
