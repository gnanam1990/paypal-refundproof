# DR-0007: PayPal execution and reconciliation (M04)

Date: 2026-11-12. Status: ACCEPTED (build-first round). The real-sandbox acceptance runs (T-007, T-009, T-010)
are **BLOCKED_CREDENTIAL** and deferred to FINAL TEST.

## Boundary

`src/paypal/client.ts` is a sandbox-only REST client.

- Base URL `https://api-m.sandbox.paypal.com`. Any other `*.paypal.com` host is refused, and `PAYPAL_ENV` must
  be `sandbox`.
- Credentials come from the server environment (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) and are never logged
  or returned.
- With no credential, execution returns 503 `PAYPAL_BLOCKED`, the worker registers no refund handlers, and
  nothing is sent.
- Only the endpoints verified in DR-0001 are used:
  - OAuth client credentials;
  - `GET /v2/payments/captures/{id}`, which is also the `PAYPAL_SANDBOX` capture source;
  - `POST /v2/payments/captures/{id}/refund` with the frozen outbound body and the operation's
    `PayPal-Request-Id`;
  - `GET /v2/checkout/orders/{id}`, whose refunds are matched by the operation's own `invoice_id` and
    `custom_id`;
  - `GET /v2/payments/refunds/{id}`.
- Every call has a deadline.

## Execution (`src/services/execution.ts`)

1. **Request.** `POST /api/revisions/:id/execute` requires an APPROVED revision whose capture snapshot came from
   the same source the client uses, so a `CONTRACT_STUB` capture can never be refunded on PayPal. It creates the
   one operation through the ledger (INV-01 and INV-02 are enforced in the database) and enqueues
   `DISPATCH_REFUND` in the same transaction.
2. **Preparation and preflight.** `DISPATCH_REFUND` obtains a token before anything is recorded. Then it holds the
   fenced lease and, in one transaction, re-checks three things:
   - the approval is live;
   - the snapshot source matches;
   - the frozen outbound request still equals a rebuild from the approved content (`assertOutboundMatches`).

   Any refusal moves the operation to `CANCELLED_BEFORE_DISPATCH` with never-dispatched evidence. Otherwise the
   operation moves `READY -> SUBMITTING` and a DISPATCHING attempt is recorded.
3. **Send.** The refund is sent outside any transaction.
4. **Record.** A second fenced transaction records the observation and the attempt outcome (RESPONDED or LOST),
   then applies the DR-0001 classification:

   | Outcome | Transition |
   | --- | --- |
   | `COMPLETED` | `CONFIRMED` |
   | `PENDING` | `RECONCILING` |
   | `FAILED` / `CANCELLED` / 400-403-404-422 | `PROVIDER_TERMINAL_NOT_APPLIED` |
   | 401 / 429 | Same request id, bounded retries |
   | Anything else (409, 5xx, timeout, reset, unparseable) | `OUTCOME_UNKNOWN`, then reconcile |

5. **Interrupted run.** If a worker dies mid-send, the next run finds a DISPATCHING attempt. It records that
   attempt as LOST and moves the operation to OUTCOME_UNKNOWN; it never resends blindly.
6. **Reconciliation.** `RECONCILE_REFUND` looks up the refund by id, or the order refunds by `invoice_id` and
   `custom_id`.
   - **Completed:** the operation becomes CONFIRMED.
   - **Terminal:** the operation becomes PROVIDER_TERMINAL_NOT_APPLIED.
   - **Pending, absent or ambiguous:** never terminal. Lookups back off exponentially up to one hour. After the
     reconciliation deadline (default 24 h) the operation becomes EXHAUSTED.
   - **Recovery:** `POST /api/operations/:id/reconcile` resumes lookups from EXHAUSTED, and
     `POST /api/operations/:id/escalate` records an escalation. Neither dispatches again.

Every effect write first calls `holdLease`, which matches id + owner + fence on an unexpired lease (0003).

## Not built / limits

- A connect failure cannot be proven "not sent" after the DISPATCHING attempt exists (0002), so it is
  reconciled rather than retried.
- Webhooks are not used.
- No real sandbox call has been made.
