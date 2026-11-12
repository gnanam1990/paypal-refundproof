# DR-0006: Approval policy (M03)

Date: 2026-11-12. Status: ACCEPTED (build-first round; the T-003/T-004 matrices are deferred to FINAL TEST).

## Flow

1. **Submit.** An operator submits a DRAFT revision that has no correction reasons, a refundable capture
   snapshot and a matching capture id. The revision becomes REVIEWABLE, and an approval request records the
   requester and the exact revision digest.
2. **Review.** The approver reads `GET /api/revisions/:id/approval`. Every fact is derived from the stored,
   digest-checked revision:
   - the capture snapshot and its source label;
   - the EXACT amount and currency, or the FULL semantic with the captured amount;
   - the reason, note, evidence digests, policy, and the approver role it requires.
3. **Decide.** The approver submits a decision with the digest they viewed. A different digest returns 409
   `STALE_APPROVAL_VIEW`.
   - Separation of duties: neither the author nor the requester may decide.
   - `policy-v1` requires an ADMIN above the per-currency limit and for every currency without one.
   - FULL requires `fullRefundConsent.captureAmount` equal to the captured amount.
   - The expiry is the policy TTL (60 minutes).
4. **Revoke.** An approval can be revoked until an operation exists. Approvals that lapse unused are marked
   EXPIRED.

## Database enforcement (0006)

- Policies are immutable versions, and approval requests are append-only.
- An approval insert must:
  - match a REVIEWABLE revision's digest;
  - come from an enabled APPROVER/ADMIN of the tenant who is neither author nor requester;
  - when APPROVED, reference its request, carry FULL consent for FULL revisions, and expire within the policy
    TTL.
- A revision becomes APPROVED only with a live approval of its digest.
- **INV-01.** A refund operation insert requires the exact, live, approved revision and its approval. The
  ledger's application-level recheck (M01) still runs too.

Amount limits are enforced in the service, because the revision stores amounts as canonical JSON rather than as
minor-unit columns.
