# Build status

Project status: **IN_PROGRESS**. Repository: `gnanam1990/paypal-refundproof` (private). Updated 2026-11-12.

## Modules

| Module | Status | PRs | Merge SHA |
| --- | --- | --- | --- |
| M00 contracts | MERGED (two post-merge corrective PRs, both merged) | #1 (head `4ed3926`), #2 corrective (head `442ec3f`), #3 corrective (head `d0b033e`) | `b7d24aa`, `af73ca0`, `ea11710` |
| M01 persistence-auth | MERGED (reviewed head `c6994de`) | #4 | `72dd748` |
| M02 ai-proposal | MERGED (head `e40b34e`, fast typecheck review); T-002 matrix deferred to FINAL TEST; real model call BLOCKED_CREDENTIAL | #5 | `eff4545` |
| M03 approval-policy | MERGED (head `10cb2d0`); T-003/T-004 matrices deferred to FINAL TEST | #6 | `8d3bb46` |
| M04 paypal-reconciliation | IN_REVIEW — built (build-first); sandbox acceptance (T-007/T-009/T-010) BLOCKED_CREDENTIAL | M04 PR | — |
| M05 product-ui-delivery | NOT_RUN | — | — |

- **M00**: PR #1 merged; a post-merge review of `4ed3926` found H1–H4, closed by PR #2 (`af73ca0`). An
  independent post-merge review of `af73ca0` returned REQUEST CHANGES (closed-shape decoder parity, operation
  identity bound IDs, dev-dependency audit); corrective PR #3 fixed them, passed independent exact-head
  re-review at `d0b033e` and was true-merged as `ea11710` (merge tree equals the reviewed head tree).
- **M01**: branch `m01-persistence-auth` (security fixes S1–S3) with main merged in twice, never rebased:
  `af73ca0` (merge `28e80bf`) and `ea11710` (merge `a2a659e`). The new audit gate then failed on M01's
  production dependency `next@15.5.29` (pins `postcss@8.4.31`: 2 high, 2 moderate); fixed by `next@16.4.6`.
  The independent review of PR #4 at `c808bb9` reproduced three integrity blockers. Each is fixed by a forward
  migration (DR-0004, `docs/evidence/M01-corrective/`):
  - `0002`: a dispatching attempt could be rewritten as NOT_SENT;
  - `0003`: a same-owner stale lease was not fenced;
  - `0004`: cross-tenant or unbound evidence could confirm an operation.
  PR #4 passed independent exact-head review at `c6994de` and was merged as `72dd748`. Hosted Actions stayed
  CI_BLOCKED (zero steps). GitGuardian finding 39989919 (`scripts/seed.ts`) is the known false positive on a
  runtime `randomBytes` demo password; it was not dismissed and history was not rewritten.

## CI

Hosted GitHub Actions: **CI_BLOCKED** — the job is never started ("recent account payments have failed or
your spending limit needs to be increased"); zero steps have run on any PR. Every CI result recorded in a PR
is the local substitute `scripts/local-ci.sh <sha>`: fresh clone of the remote at the exact SHA, then the
workflow's steps. GitGuardian (hosted app) passed on PRs #1–#3. On PR #4 it reports a "Generic Password" in
`scripts/seed.ts` (commit `76fa6a2`): a false positive on a runtime `randomBytes` value. It stays open: it is
not dismissed in the dashboard, and no history is rewritten.

## Integrations

| Integration | Status | Evidence needed |
| --- | --- | --- |
| PayPal REST sandbox | **BLOCKED** — no sandbox credentials in this environment | sandbox app client id/secret in gitignored `.env.local` |
| PayPal / Venmo live (production) | **BLOCKED** — no live credentials and no authorization for live refunds; nothing in this repo calls a live endpoint | real live credentials plus explicit written authorization for named live tests |
| Model API (Anthropic) | **BLOCKED** — no API key in this environment | `ANTHROPIC_API_KEY` (or an `ant auth login` profile) for the server process |

## Test plan

| Test | Status |
| --- | --- |
| T-005, T-006 | PASS (domain, property; T-006 full chain added in PR #2); durable T-005 race PASS on the M01 branch |
| T-001, T-008 (queue/worker restart) | PASS on the M01 branch (not yet merged); T-008 reconciliation phase is M04 |
| T-002, T-003, T-004, T-007, T-010, T-011, T-012 | NOT_RUN |
| T-009 | BLOCKED (PayPal sandbox credentials) |
