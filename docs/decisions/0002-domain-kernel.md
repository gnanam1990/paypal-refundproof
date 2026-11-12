# DR-0002 — Domain kernel decisions (M00)

Date: 2026-11-12. Status: ACCEPTED. No prior money or idempotency type existed in the repository.

1. **Money** is integer minor units (`bigint`) with PayPal's currency exponents (HUF/JPY/TWD = 0).
   Parsing is strict: more fractional digits than the currency allows is an error, never rounded.
   Maximum 999 999 999 999 minor units.
2. **Amount semantics** are a closed union `EXACT(amount) | FULL(captureAmount)`. An omitted amount is
   unrepresentable; `FULL` is the only way the adapter may send an empty refund body.
3. **Canonical digests** use sorted-key JSON restricted to stable encodings (no floats, no
   undefined, no non-plain objects) with a domain-separation prefix. Golden vector computed
   independently with `shasum`.
4. **Operation identity is derived, not random**: `sha256(domain, {tenantId, revisionId,
   revisionDigest})` yields `operationId`, `PayPal-Request-Id`, `invoice_id` and `custom_id`. Concurrent
   workers on the same approved revision compute the same identity; any other revision id (even
   identical content) computes a different one. Identities are stored once allocated (M01), and the
   derivation is pinned by a vector test so a deploy cannot silently change it.
5. **States added beyond TDD.md**, each narrower than the alternatives:
   - Proposal `SUPERSEDED`: an edited revision's predecessor, so "any change creates a new DRAFT" leaves
     no approvable stale revision.
   - Proposal `APPROVED -> REJECTED | EXPIRED`: revocation or lapse, only before dispatch (enforced in M03/M04).
   - Operation `CANCELLED_BEFORE_DISPATCH`: the carrier of durable NEVER_DISPATCHED evidence (not a
     provider state).
   - Operation `SUBMITTING -> READY`: only for an attempt durably recorded NOT_SENT.
   - Operation `SUBMITTING -> RECONCILING`: PayPal answered with a `PENDING` refund.
   - Operation `EXHAUSTED -> RECONCILING`: manual, read-only re-reconciliation. No retry edge exists from
     OUTCOME_UNKNOWN or EXHAUSTED.
6. **Bounded work**: `BoundedRetryPolicy` rejects infinite/zero bounds; decisions return explicit
   `EXHAUSTED` at the attempt bound or deadline and never schedule past the deadline.
