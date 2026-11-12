# M01 handoff — persistence and authorization

Owns FR-06 (durable trail portion), NFR-01, INV-03 (database enforcement), T-001, T-008.
Branch `m01-persistence-auth`, based on `main@b7d24aa` (M00 merged).

## Red evidence

Before implementation: integration suite 4 of 5 files failed to load (services absent), restart suite 2
of 2 failed: [`red-integration.txt`](red-integration.txt), [`red-restart.txt`](red-restart.txt).

Defects the tests caught during implementation (each failed first, then was fixed):

1. Zero-row `DELETE FROM state_transitions` was not refused (row-level trigger never fires) → append-only
   guards are now statement-level and also block `TRUNCATE`.
2. T-008: SIGKILL of the worker left the job being completed by "worker-A" — the `tsx` CLI forks a child,
   so the real worker was orphaned and kept running. Workers now run as one process (`node --import tsx`).
3. Denial audits written inside a transaction were rolled back with the 404 → denials are attached to the
   error and persisted by the request boundary.

## Green evidence (`pnpm -s verify`, exit 0)

| Suite | Files | Tests | What it proves |
| --- | --- | --- | --- |
| unit + property | 8 | 92 | M00 kernel (unchanged) |
| integration (real PostgreSQL 17, private cluster) | 5 | 34 | migrations up/down/up + checksum; DB transition tables == domain; tenant FKs; append-only; immutable revisions; one live revision; correction-required cannot leave DRAFT; **T-005 durable race** with 2/4/8 workers on separate pools → 1 operation, attempts 1..N under one request id; conflict on digest mismatch; unapproved revision refused; CONFIRMED / cancellation without evidence refused; outbox tx-rollback, disjoint SKIP LOCKED claims, lease reclaim, stale-owner rejection, dead-letter; auth cookie flags, wrong-password parity, rate limit 429, logout, expiry, CSRF, cross-origin, closed schemas, cross-tenant 404 + audit, role denial, evidence encryption + redaction + idempotent re-admission + size bound + case audit trail |
| restart | 2 | 4 | **T-001**: evidence + revision written, cluster crash-stopped (`pg_ctl -m immediate`), restarted, re-read by a separate process (`scripts/case-inspect.ts --verify`): identical digests, recomputed digests match, original decrypts to the same SHA-256, no PII in output. **T-008 (queue)**: SIGKILLed worker's job reclaimed and finished by a new process (attempts 2, one effect); live lease renewal prevents a concurrent second run; worker survives a database crash-restart and completes new work |
| served (`next build` + `next start`) | 1 | 1 | real HTTP API: login, case, evidence; web process SIGKILLed and restarted; session and data durable |

Plus `format:check`, `lint`, `typecheck`, `secret-scan` (0 findings / 131 files), `pack:check` PASS.

## Local runtime evidence

Local dev database `refundproof` created (did not previously exist), `pnpm db:migrate` → `0001_core`
applied, `pnpm seed` → one labeled demo tenant (`DEMO — Sandbox Merchant (seeded)`) with three labeled
accounts; credentials written to gitignored `.local/seed-accounts.json` (mode 600), never printed.

## Remaining

T-008's reconciliation-phase restart is re-run in M04 against real refund reconciliation. Proposal
generation (M02), approval service (M03), PayPal execution (M04), console UI (M05): NOT_RUN.
`approveForTest` in `test/support/fixtures.ts` is a labeled test-only shortcut until M03 supplies the
approval service.
