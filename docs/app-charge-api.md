# FiberPass App Charge API

Apps should charge a pass through the backend, never directly from the browser.

## Required Behavior

- Send an app API key.
- Send an idempotency key for every charge.
- Send a Fiber payment request when using the Fiber rail.
- Scheduled invoice/recipient payouts are Fiber-only and require Fiber invoice/payment requests; FiberPass bridges reserved vault liquidity into channel liquidity when needed.

## Receipt Fields

Successful charge attempts return and persist:

- execution layer: `fiber` or `ckb-vault`
- proof type
- transaction hash or Fiber proof id
- explorer URL when the proof is a CKB transaction
- idempotency key
- service reference
- remaining pass balance

## Failure Handling

Apps should treat these as final user/pass state failures:

- `APP_SESSION_MISMATCH`
- `SESSION_NOT_CHARGEABLE`
- `SESSION_EXPIRED`
- `SESSION_LIMIT_EXCEEDED`
- `DAILY_SESSION_LIMIT_EXCEEDED`
- `FIBER_INVOICE_REQUIRED`
- `FIBER_INVOICE_AMOUNT_REQUIRED`
- `FIBER_INVOICE_AMOUNT_MISMATCH`
- `FIBER_INVOICE_CURRENCY_MISMATCH`
- `FIBER_INVOICE_NETWORK_MISMATCH`
- `FIBER_INVOICE_UNSIGNED`
- `FIBER_INVOICE_EXPIRED`
- `FIBER_PAYMENT_PROOF_MISSING`
- `FIBER_PAYMENT_PROOF_MISMATCH`

Retry only transport errors and temporary provider failures with the same idempotency key.

FiberPass parses every invoice through the configured Fiber RPC before payment. The invoice must be signed, encode the exact CKB amount being debited, match the configured Fiber network, remain unexpired, and return a successful payment hash proof.
