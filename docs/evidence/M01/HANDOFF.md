# M01 handoff — persistence and authorization

Owns FR-06 (durable trail portion), NFR-01, INV-03 (database enforcement), T-001, T-008.
Branch `m01-persistence-auth`, started from `main@b7d24aa`; main merged in (never rebased) at `af73ca0` and
`ea11710` (M00 corrective hardening #1 and #2).

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

## Security review (automated, on 44b4a19) — S1–S3

Red: [`security-red.txt`](security-red.txt) (5 of 6 failed before fixes). Fixes and mutation proof in
DR-0003. After fixes: integration 6 files / **40 tests**, restart 2 / 4 (T-001 now also asserts the CLI
prints no unkeyed hash of the original).

## Update onto main `ea11710` (merge `a2a659e`)

Conflicts in `package.json` and `pnpm-lock.yaml` only: M01's scripts kept, main's audit gate added to both
`verify:m00` and `verify`, lockfile regenerated and frozen-install verified. The audit gate then failed on
M01's own production dependency `next@15.5.29` ([`audit-before.txt`](audit-before.txt): 2 high, 2 moderate
in its pinned `postcss@8.4.31`). Upgraded to `next@16.4.6` ([`audit-after.txt`](audit-after.txt): no known
vulnerabilities); rationale and framework-boundary checks in DR-0003.

Current counts on the merged branch:

| Suite | Files | Tests |
| --- | --- | --- |
| unit + property (M00 kernel incl. corrective #2) | 11 | 195 |
| integration (real PostgreSQL 17) | 7 | 46 |
| restart (T-001, T-008 queue) | 2 | 4 |
| served (`next build` + `next start`, Next 16.4.6) | 1 | 2 |

The new served test checks security headers, no `X-Powered-By`, cookie flags, 403 on cross-origin and
missing CSRF, and 413 on an oversized body through the real server. Mutation proof: `poweredByHeader: true`
fails it (`expected 'Next.js' to be null`), and so does removing `X-Frame-Options`.

PayPal REST sandbox, PayPal/Venmo live, and the model API stay **BLOCKED**: no credentials, and no live
calls are authorized or made.

## Security finding L1 (automated push review of `02d31af`): sign-in lockout

The account-only login limiter let anyone who knew an email lock that account out. Red evidence:
[`security-l1-red.txt`](security-l1-red.txt). The new suite failed 6 of 6, and a direct reproduction shows
the owner's correct password getting `429 to be 200`. Fixed with signed, account-bound device cookies that
get their own failure bucket; design, rejected alternatives and residual risk are in DR-0003. Mutation
proof: [`security-l1-mutations.txt`](security-l1-mutations.txt).

The existing S1 test "a successful sign-in does not consume the failure budget" now probes the untrusted
bucket from a fresh client. After a success, the original client holds a device cookie and its failures
go to its own bucket, which is the intended change. Both the 5th-failure-allowed and the 6th-refused
assertions are unchanged.

