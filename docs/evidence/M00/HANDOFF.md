# M00 handoff — contracts

Owns FR-03, NFR-03, INV-02, T-005, T-006. Branch `m00-contracts`. Base `main@e693678`.

## Red evidence (before implementation)

`pnpm vitest run --project unit` → exit 1, 6 suites failed to load (`src/domain/*` absent):
[`red.txt`](red.txt). Mutation check after green: making the model ledger's insert use a stale read
made the T-005 race property fail with a counterexample; restored → green.

## Green evidence

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | clean |
| `pnpm typecheck` | 0 | clean |
| `pnpm test:unit` (run 1, run 2) | 0, 0 | 7 files, 75 tests passed each run ([run1](green-run1.txt), [run2](green-run2.txt) recorded at 74 before the vector pin) |
| `pnpm identity:vectors` ×2 + `diff` | 0 | identical ([vectors](identity-vectors.json)) |
| `pnpm secret-scan` | 0 | 0 findings; planted-secret self-test → exit 1 with 2 findings |
| `pnpm pack:check` | 0 | PASS |

T-005: property (identical identity on every retry; attempts share request id; PayPal-compatible
lengths) and fast-check scheduler race of 2–8 workers → exactly one operation, one creator,
attempts 1..N under one request id. T-006: ten bound-field mutations each change the revision digest,
operation id, request id and invoice id; identical content under a new revision id gets a new identity.
Also: overflow, currency, malformed-value, canonicalization and invalid-transition negatives.

This module has no PayPal boundary and no database: proof is deterministic domain behavior only.
The race uses a test-only reference ledger; the durable ledger must pass the same contract in M01/M04.

## Remaining

T-001…T-004, T-007…T-012 and modules M01–M05: NOT_RUN.
