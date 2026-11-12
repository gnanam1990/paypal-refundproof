# Build status

Project status: **IN_PROGRESS**. Repository: `gnanam1990/paypal-refundproof` (private). Updated 2026-11-12.

## Modules

| Module | Status | PRs | Merge SHA |
| --- | --- | --- | --- |
| M00 contracts | MERGED, under corrective hardening | #1 (head `4ed3926`), #2 corrective (head `442ec3f`), #3 corrective (open) | `b7d24aa`, `af73ca0` |
| M01 persistence-auth | BUILT, **HELD** — not merged | none open | — |
| M02 ai-proposal | NOT_RUN | — | — |
| M03 approval-policy | NOT_RUN | — | — |
| M04 paypal-reconciliation | NOT_RUN | — | — |
| M05 product-ui-delivery | NOT_RUN | — | — |

- **M00**: PR #1 merged; a post-merge review of `4ed3926` found H1–H4, closed by PR #2 (`af73ca0`). An
  independent post-merge review of `af73ca0` returned REQUEST CHANGES (closed-shape decoder parity, operation
  identity bound IDs, dev-dependency audit); corrective PR #3 addresses it and awaits exact-head re-review.
- **M01**: branch `m01-persistence-auth` at `1cce764` on the remote (includes security fixes S1–S3); a trial
  merge of `af73ca0` exists locally only (`28e80bf`, not pushed). It stays held until M00 hardening is
  accepted, then it is updated onto main and reviewed.

## CI

Hosted GitHub Actions: **CI_BLOCKED** — the job is never started ("recent account payments have failed or
your spending limit needs to be increased"); zero steps have run on any PR. Every CI result recorded in a PR
is the local substitute `scripts/local-ci.sh <sha>`: fresh clone of the remote at the exact SHA, then the
workflow's steps. GitGuardian (hosted app) has run and passed.

## Integrations

| Integration | Status | Evidence needed |
| --- | --- | --- |
| PayPal REST sandbox | **BLOCKED** — no sandbox credentials in this environment | sandbox app client id/secret in gitignored `.env.local` |
| Model API (Anthropic) | **BLOCKED** — no API key in this environment | `ANTHROPIC_API_KEY` (or an `ant auth login` profile) for the server process |

## Test plan

| Test | Status |
| --- | --- |
| T-005, T-006 | PASS (domain, property; T-006 full chain added in PR #2); durable T-005 race PASS on the held M01 branch |
| T-001, T-008 (queue/worker restart) | PASS on the held M01 branch only (not merged) |
| T-002, T-003, T-004, T-007, T-010, T-011, T-012 | NOT_RUN |
| T-009 | BLOCKED (PayPal sandbox credentials) |
