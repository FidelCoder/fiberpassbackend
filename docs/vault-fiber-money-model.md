# FiberPass Vault and Fiber Network Model

FiberPass uses the vault as the customer liquidity ledger and Fiber Network as payment infrastructure.

## Source of Funds

- Users load CKB into the FiberPass vault address.
- The backend records the deposit against the connected JoyID CKB wallet.
- Creating a pass reserves that user's vault balance by moving it from available balance into the pass limit.
- Charges and scheduled payouts spend from the reserved pass balance.
- Closing, revoking, or settling a pass returns unused reserved balance to that user's available vault balance.

The dashboard must show the logged-in user's vault balance and pass history, not cumulative vault funds and not the operator node wallet balance.

## Fiber Network Role

Fiber nodes are infrastructure for payment execution and future channel/app payments. They are not individual user wallets.

- App/API charges execute through the Fiber payment adapter with a real payment request.
- Scheduled invoice payouts require a Fiber invoice/payment request. Plain CKB wallet addresses are not valid Fiber payout destinations.
- When Fiber channel liquidity is insufficient, FiberPass bridges the reserved user vault liquidity to the Fiber node funding lock, opens channel liquidity, and retries the Fiber payment when the channel is active.
- The Fiber node wallet may hold small operator buffer for channel fees/change, but user balances remain tracked by vault accounting.

## Charge Invariants

Every charge attempt must be persisted with:

- session id and owner wallet id
- amount and currency
- idempotency key for app/API requests
- service reference when supplied by an app or invoice system
- reserve status: `reserved`, `debited`, or `released`
- execution layer: `fiber` or `ckb-vault`
- proof type and proof id/transaction hash when successful
- failure code and message when blocked or failed

A successful charge increments pass spent balance exactly once. A failed charge does not spend reserved funds.
