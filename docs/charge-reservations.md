# Charge Reservation Invariants

FiberPass requires MongoDB transactions. Production MongoDB must run as a replica set or sharded cluster; a standalone `mongod` is not a supported deployment target.

Every app, automation, scheduled, and Fiber-exit charge has a session-scoped idempotency key. Reservation creates the unique attempt and increments both the pass reservation and UTC daily reservation in one transaction. A charge can reach the provider only after it owns an execution lease and persists its provider correlation.

Provider states:

- `not_started`: safe to execute after acquiring an expired or new lease.
- `submitted`: provider call began; do not send again.
- `uncertain`: reconcile by provider correlation before any retry.
- `succeeded`: provider proof is durable; finalize the reservation without another payment.
- `failed`: provider reported a definite failure and the reservation is released.

Finalization atomically moves the pass and daily amounts from reserved to spent and marks the attempt debited. If this transaction fails after provider success, the next call with the same idempotency key finalizes the stored success instead of issuing another provider payment.

Run the contention and crash recovery suite against an isolated Mongo replica set:

```bash
CHARGE_RESERVATION_TEST_MONGODB_URI=mongodb://127.0.0.1:27018/?replicaSet=rs0 npm run test:charge-reservations
```
