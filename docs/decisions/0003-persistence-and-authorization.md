# DR-0003 — Persistence, authorization and durable scheduling (M01)

Date: 2026-11-12. Status: ACCEPTED.

## Migration `0001_core` (up + down)

Rollback (`0001_core.down.sql`) drops every RefundProof object and therefore all data: it is for empty or
development databases only. There is no production data; no destructive migration risk exists yet.

## Database-enforced rules (not UI convention)

- **Tenant isolation**: every child table carries `tenant_id` with composite foreign keys
  `(tenant_id, x_id) → parent(tenant_id, id)`, so a row can never reference another tenant's case,
  revision, approval or actor. The API additionally scopes every query by the session actor's tenant and
  answers cross-tenant access with 404 (audited as `ACCESS_DENIED`).
- **One operation per approved revision**: `refund_operations.approved_revision_id` is `UNIQUE`;
  `paypal_request_id`, `invoice_id`, `custom_id` are `UNIQUE`; a trigger makes identity columns and the
  frozen `outbound_snapshot` immutable. `provider_attempts (operation_id, paypal_request_id)` is a foreign
  key to `refund_operations (id, paypal_request_id)`: an attempt cannot carry another request id.
- **No duplicate effect per case/capture**: partial unique indexes allow at most one effect-possible
  operation per case and one unresolved operation per capture.
- **State machines in SQL**: `operation_transition_rules` / `proposal_transition_rules` mirror
  `src/domain/states.ts` (a test fails on drift). The operation trigger additionally requires durable
  evidence: `CONFIRMED` needs a `REFUND_COMPLETED` observation for that operation; terminal non-application
  needs a terminal observation; cancellation needs `never_dispatched_evidence` and no attempt other than
  `NOT_SENT`; `SUBMITTING → READY` needs every attempt `NOT_SENT`. An attempt that left `DISPATCHING`
  can never be rewritten.
- **Immutability / append-only**: revisions, approvals (except one revocation), evidence, observations,
  audit events and state transitions reject update/delete/truncate (statement-level triggers, so even a
  zero-row delete is refused). Every state change is recorded in `state_transitions` by trigger.

## Authentication

scrypt (N=2^15, r=8, p=1) password hashes; constant-work verification for unknown accounts. Session tokens
are 256-bit random, stored only as SHA-256; cookie `rp_session` is `HttpOnly; SameSite=Lax` (+`Secure` when
the origin is https). Every mutation requires the exact configured `Origin` and the session-bound CSRF
token. Failed logins are rate-limited per account in PostgreSQL (5 / 15 min by default). Roles:
`OPERATOR` (import cases, evidence, proposals), `APPROVER` (approve; read-only otherwise), `ADMIN`.

## Evidence protection (NFR-02, partial; M02 completes admission)

Originals are AES-256-GCM encrypted with `REFUNDPROOF_DATA_KEY` (server-only env); a deterministic
redacted copy (emails, card numbers, IBAN, phone, SSN) is the only form displayed or exported. The
evidence digest binds the exact original: `sha256(domain, {kind, sha256(original)})`.

## Durable scheduling

`outbox_jobs` is a transactional outbox: enqueue in the same transaction as the state change it schedules.
Workers claim with `FOR UPDATE SKIP LOCKED` plus a lease, renew the lease at a third of its length, and a
job whose lease expires is reclaimed by another worker (dead-lettered after `max_attempts`). Handlers whose
effect is a database write complete the job in the same transaction (exactly-once effect).

Worker processes are started as a single Node process (`node --import tsx`), never through the `tsx` CLI:
the CLI forks a child, and T-008 showed that signalling the wrapper orphaned the real worker.
