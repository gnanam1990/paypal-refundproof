# M01 corrective handoff: attempt finality, lease fencing, tenant-bound evidence

The independent review of PR #4 at `c808bb9` (base `ea11710`) reproduced three blockers. This round fixes them
on the same branch, with no rebase, no force-push and no history rewrite. Design and rules: DR-0004.

## Red evidence (new tests on unchanged code)

| Suite | Result before the fix | File |
| --- | --- | --- |
| `attempt-finality` (Blocker 1) | 39 of 64 failed. Reproduction: `DISPATCHING -> NOT_SENT` UPDATE resolved | [`red-attempt-finality.txt`](red-attempt-finality.txt) |
| `lease-fencing` (Blocker 2) | 13 of 15 failed. Reproduction: stale same-owner `completeJob` resolved | [`red-lease-fencing.txt`](red-lease-fencing.txt) |
| `tenant-binding` (Blocker 3) | 11 of 22 failed. Reproduction: tenant-B observation for tenant-A operation inserted | [`red-tenant-binding.txt`](red-tenant-binding.txt) |
| `migrations-upgrade` | 4 of 5 failed: no backfill, and violating legacy rows were accepted | [`red-migrations-upgrade.txt`](red-migrations-upgrade.txt) |

The Blocker 3 red run also showed that a `REFUND_COMPLETED` observation with `operation_id NULL` could confirm
an operation. The guard's `<>` comparison yields NULL there, so the check never fired. This is fixed in `0004`.

After the red run, the mutation runs below required four tests to be added and three strengthened. The "first
run" lines in the mutation files show which mutant each change kills:
- Blocker 3: four single-layer tests added.
- Blocker 1: the born-phase test now uses a coherent future finish time, and the insert-race test became a
  deterministic interleaving.
- Blocker 2: the cross-claim retry test was extended.

## Mutation proof (planted regressions in the shipped SQL or TypeScript)

| File | Killed | Notes |
| --- | --- | --- |
| [`mutations-b1.txt`](mutations-b1.txt) | 7 of 8 | B1-h is an equivalent mutant: the coherence check and the identity clause already pin every `DISPATCHING` field |
| [`mutations-b2.txt`](mutations-b2.txt) | 6 of 6 | Includes missing fence, missing expiry, no fence bump, retry acknowledged across actions or claims, and effect written before fenced completion |
| [`mutations-b3.txt`](mutations-b3.txt) | 10 of 10 | Each composite key and each trigger check is removed on its own |
| [`mutations-upgrade.txt`](mutations-upgrade.txt) | 2 of 2 | Missing `NOT_SENT` backfill; `0004` rollback leaving a binding behind |

## Upgrade rehearsal

- `test/integration/migrations-upgrade.test.ts` (5 tests) covers:
  - a populated 0001 database upgrades with all counts unchanged, and its old rows obey the new rules;
  - violating legacy rows stop the right migration, which commits nothing;
  - `0004..0002` roll back and re-apply with data present.
- Fresh database: the template and the migration round-trip test.
- Local dev database `refundproof`: upgraded `0001 -> 0004` with every count unchanged
  ([`dev-db-upgrade.txt`](dev-db-upgrade.txt)). It holds only the seeded demo tenant and three accounts, so the
  populated rehearsal above is the meaningful one.

## Green (local `pnpm -s verify`, exit 0)

| Suite | Files | Tests |
| --- | --- | --- |
| unit + property | 11 | 195 |
| integration (real PostgreSQL 17) | 11 | 156 |
| restart (T-001, T-008 queue) | 2 | 4 |
| served (`next build` + `next start`) | 1 | 2 |

Also passing: format, lint, typecheck, secret scan (0 findings), `pnpm audit --audit-level=low` (no known
vulnerabilities), build-pack check. The clean-clone run on the exact pushed head is recorded in the PR.

## Remaining limitations

- Attempts may still be recorded while an operation is `READY`, as the T-005 ledger contract does. The exits
  that require "never dispatched" refuse any dispatched attempt. Gating dispatch on `SUBMITTING` is M04's
  dispatcher.
- Lease expiry uses the database clock. A handler whose effect is outside PostgreSQL (the M04 PayPal call) still
  needs that call to be idempotent: it reuses the operation's fixed `PayPal-Request-Id`. Fencing protects the
  durable write that records the outcome; it cannot recall a network request already sent.
- An in-flight lease at upgrade time is fence `0`. It has to expire and be reclaimed; no running worker
  survives a schema upgrade.
- Hosted Actions is CI_BLOCKED, and PayPal sandbox, PayPal/Venmo live and the model API are BLOCKED. The
  GitGuardian `scripts/seed.ts` false positive stays open as a hosted process gate.
