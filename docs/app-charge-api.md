# FiberPass App Charge API

Apps should charge a pass through the backend, never directly from the browser.

## Required Behavior

- Send an app API key.
- Send an idempotency key for every charge.
- Send a Fiber payment request when using the Fiber rail.
- Send the pass payment reference whenever the pass has one configured.
- Scheduled invoice/recipient payouts are Fiber-only and require Fiber invoice/payment requests; FiberPass bridges reserved vault liquidity into channel liquidity when needed.

## Owner-Bound App Grants

Direct app charges require a durable grant from the pass owner's wallet. A grant binds the pass to the registered app id, app owner wallet, service address, and the structured `charges:create` permission. A matching service address by itself never grants access.

New passes can set `appId` to an active developer app owned by the authenticated wallet. To authorize an existing manual pass, its owner calls `POST /sessions/:id/app-grant` with:

```json
{
  "appId": "fp_app_example",
  "appPermissions": ["charges:create"]
}
```

Manual and legacy passes without this explicit grant remain owner-controlled. Setting `autoMicroCharges` to `false` also blocks all direct app API charges without affecting trusted scheduled payout workers.

## Receipt Fields

Successful charge attempts return and persist:

- execution layer: `fiber` or `ckb-vault`
- proof type
- transaction hash or Fiber proof id
- explorer URL when the proof is a CKB transaction
- idempotency key
- service reference
- provider status and correlation id while reconciliation is pending
- reserved pass balance while a provider outcome is pending
- remaining pass balance

## Failure Handling

Apps should treat these as final user/pass state failures:

- `APP_SESSION_MISMATCH`
- `APP_AUTH_CONTEXT_REQUIRED`
- `APP_OWNER_MISMATCH`
- `APP_SESSION_GRANT_REQUIRED`
- `APP_GRANT_OWNER_MISMATCH`
- `APP_SERVICE_ADDRESS_MISMATCH`
- `APP_CHARGES_DISABLED`
- `APP_SESSION_PERMISSION_REQUIRED`
- `PAYMENT_REFERENCE_REQUIRED`
- `PAYMENT_REFERENCE_MISMATCH`
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

The following states must be retried with the same idempotency key. FiberPass will reconcile or finalize the existing attempt and will not create a second provider payment:

- `CHARGE_ATTEMPT_PENDING`
- `CHARGE_OUTCOME_UNCERTAIN`
- `CHARGE_FINALIZATION_PENDING`

`CHARGE_ATTEMPT_FAILED` is final for that idempotency key. Submit a corrected request with a new key only after inspecting its stored failure code. Requests without a key fail with `IDEMPOTENCY_KEY_REQUIRED`.

Retry only transport errors and temporary provider failures with the same idempotency key.

FiberPass parses every invoice through the configured Fiber RPC before payment. The invoice must be signed, encode the exact CKB amount being debited, match the configured Fiber network, remain unexpired, and return a successful payment hash proof.
