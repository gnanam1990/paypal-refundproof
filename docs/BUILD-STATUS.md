# Build status

Project status: **SANDBOX PRODUCT COMPLETE; SUBMISSION PREPARED**. Repository:
`gnanam1990/paypal-refundproof` (private until the final publication confirmation). Updated 2026-11-12.

## Module delivery

| Module | Status | Pull requests | Merge SHA |
| --- | --- | --- | --- |
| M00 domain contracts | MERGED, including two corrective hardening rounds | #1–#3 | `ea11710` final M00 merge |
| M01 persistence and authorization | MERGED after independent integrity corrections | #4 | `72dd748` |
| M02 bounded AI proposal | MERGED | #5 | `eff4545` |
| M03 approval and policy | MERGED | #6 | `8d3bb46` |
| M04 PayPal execution and reconciliation | MERGED | #7 | `7dfb793` |
| M05 product console | MERGED | #8 | `86e3fc3` |
| Submission hardening | MERGED: redirect fix, UI polish, Taste redesign, canonical jsonb comparison, public docs and test isolation | #9–#13 | `1491f43` final submission-doc merge |
| Real local AI proof | MERGED: loopback Ollama adapter, native structured schema, verified qwen3:4b run, public evidence | #14 | `f3c538a` final local-AI merge |

## Real provider evidence

The normal browser path executed one real PayPal sandbox refund on 2026-11-12:

| Field | Value |
| --- | --- |
| Case | `case_zgqexrbzg2a7e839k5dp6dethj` |
| Approved revision | `rev_9pbv4qkrjmnb9nmscf573b0bax` |
| Capture | `82E93566SH823383U` |
| Amount | `84.00 USD` |
| Operation | `op_a424b84631de8c0f7fe60ad83af15750` |
| PayPal request ID | `refundproof-a424b84631de8c0f7fe60ad83af157505fff2b5bf0fb8d4b11b971b7d3866744` |
| PayPal refund ID | `2MU02051VC628743S` |
| Result | HTTP `201`; PayPal sandbox status `COMPLETED`; one provider attempt |

The UI recorded `ready → sending → refund confirmed`, preserved the provider evidence, and concluded:
“PayPal confirmed this refund. Nothing else will be sent.”

## Integration status

| Integration | Status | Notes |
| --- | --- | --- |
| PayPal REST sandbox | **PASS — real provider call** | Capture read, refund creation, durable provider evidence, and confirmed reconciliation exercised through the normal UI |
| PayPal live | **INTENTIONALLY UNSUPPORTED** | The adapter refuses non-sandbox PayPal configuration |
| Proposal provider | **PASS — real local Ollama call** | `qwen3:4b` produced an exact `84.00 USD` proposal from redacted evidence; `3/3` citations verified and the revision had zero correction reasons |
| PostgreSQL + worker | **PASS — local runtime** | Migrations, seeded role-separated accounts, transactional outbox, worker dispatch, and durable operation state exercised |
| Hosted deployment | **NOT RUN** | Rules permit complete setup instructions; a serverless-only deployment would not honestly run the PostgreSQL worker architecture |

## Verification evidence

- The outbound jsonb key-order defect found during the first real provider rehearsal is fixed by PR #12. Stored and
  expected outbound snapshots are compared with canonical JSON, with a focused regression test.
- The full local verification passed on the local-AI branch: 200 unit tests, 160 integration tests, 4
  restart-recovery tests, 2 real `next start` served tests, production build, formatting, lint, TypeScript, secret scan
  (0 findings in 223 files), build-pack verification, and dependency audit (no known vulnerabilities).
- The served-process tests now explicitly disable providers instead of inheriting an operator's `.env.local`; this
  preserves the production rule that refuses the labelled local fixture while keeping the HTTP-boundary test isolated.
- Hosted GitHub Actions remain **CI_BLOCKED** because the account-level Actions job never starts after a billing/spend
  limit failure. No hosted result is represented as passing. Local clean-checkout evidence is the substitute.
- GitGuardian's existing `scripts/seed.ts` alert is a false positive on a runtime `randomBytes` development password;
  it is not dismissed or hidden.

## Real local AI evidence

| Field | Value |
| --- | --- |
| Case | `case_xy7qs6a65j8be6vgev8g667517` |
| Capture | `6PF37073XL906532F`, real PayPal sandbox, `COMPLETED` |
| Invocation | `inv_erj8bqer1ryzxgvm9vxqr3vma3` |
| Provider / served model | `ollama` / `qwen3:4b` |
| Prompt contract | `refundproof-proposal/v2` with exact request-specific schema constraints |
| Result | `SUCCEEDED`; exact `84.00 USD`; `DUPLICATE_CHARGE`; `3/3` citations; no correction reasons |
| Revision | `rev_ffbz6j9rmyk62eg859t0t8cbsk` |
| Boundary | Ready to request independent approval; no AI approval or execution |

## Submission artifacts

| Artifact | Status |
| --- | --- |
| Modern product UI | COMPLETE and merged |
| Real PayPal sandbox proof screenshot | COMPLETE |
| 64.4-second 1080p subtitles-only demo | COMPLETE and visually reviewed; real Ollama proof plus real PayPal sandbox result; SHA-256 `4c8a19de21d33ba372aaf84991eb87fb5ced52380f68788784fd68bb41551495` |
| Public-ready README and MIT license | PREPARED |
| Public GitHub visibility | PENDING final publication confirmation |
| Public YouTube URL | PENDING upload/publication confirmation |
| Devpost final submission | PENDING final action-time confirmation |
