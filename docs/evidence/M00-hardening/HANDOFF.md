# M00 post-merge corrective hardening

Status: **CORRECTIVE** — M00 was merged at `b7d24aa` (PR #1, head `4ed3926`). An independent post-merge
review of that head found four unresolved defects that the 92 passing tests did not cover. M00 is not
claimed fully resolved by PR #1; this PR closes these four findings. Merged history is not rewritten.

Branch `m00-hardening` from `main@b7d24aa`.

## Findings → requirement → tests → fix

| ID | Finding (on 4ed3926) | Requirement | Red test(s) | Fix |
| --- | --- | --- | --- | --- |
| H1 | Exported JSON Schema dropped the evidence SHA-256 constraint (zod `refine` is not representable) and money only had a generic decimal pattern, so it advertised USD `1.001`, JPY `1.5`, `0.00` and over-limit values as valid. The old test only asserted that *some* `pattern` existed. | FR-03 (canonical intent schema), SECURITY (bounded input), T-004 prerequisite | `m00-hardening.property.test.ts` › H1: 16 Ajv (draft 2020-12) rejections of the **exported** schema, valid-acceptance cases, a 2 000-run differential property (schema verdict == domain `parseMoney` verdict for arbitrary strings × all currencies), and an exhaustive-range acceptance property | `src/domain/schemas.ts`: money is a per-exponent union whose pattern encodes no leading zeros, ≤ exponent fractional digits, strict positivity and ≤ `MAX_MINOR` (load-time guard ties the pattern to `MAX_MINOR`); evidence digests use `regex(/^[0-9a-f]{64}$/)` which is exported |
| H2 | `approvalDigest` accepted impossible calendar instants (`Date.parse` rolls `2026-02-30` to March 2) and empty tenant/revision/approver/policy identifiers. | FR-02, INV-01 (approval binds exact approver and expiry) | H2: 8 impossible instants (Feb 30, non-leap Feb 29, Apr 31, month 13/00, hour 24, minute 60, second 60), leap-day acceptance, empty and >128-char identifier rejection for each of the four fields | `src/domain/identity.ts`: `assertRealUtcInstant` round-trips every component through UTC; identifiers must be 1..128 chars |
| H3 | T-006 kept one revision id and never exercised the full chain the TEST-PLAN requires: changed amount/capture → **new revision, new approval, new operation**. | FR-03, T-006, INV-01, INV-02 | H3: for amount and capture changes with distinct server revision ids: revision digest changes; the new approval digest differs; the *old* approval digest replayed onto the new revision does not match; operation id, PayPal-Request-Id, invoice_id and custom_id all change | Coverage gap (implementation was already correct). Sensitivity proven by mutation: approval digest ignoring the revision digest → 2 H3 failures |
| H4 | `normalizeRevisionContent` accepted more than 64 evidence digests (only the zod schema bounded it) and deduped before bounding, so 1 000 duplicates were silently shrunk. | SECURITY / NFR-02 (bounded evidence) | H4: exactly 64 accepted, 65 rejected, 1 000 duplicates rejected; shared constant `MAX_EVIDENCE_DIGESTS = 64` | `src/domain/proposal.ts`: bound the raw array before dedup/sort; zod and exported schema use the same constant |

Red evidence before any fix: [`red.txt`](red.txt) — 25 failed / 12 passed of 37 new tests (H1, H2, H4
behavioral failures; H3 passed, i.e. a coverage gap, then mutation-proven).

Mutation checks after fixes (both restored afterwards):

- approval digest with the revision digest removed → H3: 2 failed.
- exported value pattern widened by one fractional digit → H1: 2 failed (differential + explicit rejection).

## Green evidence

`pnpm -s verify:m00` (format, lint, typecheck, unit ×1, secret-scan, pack:check) and the clean-checkout
`scripts/local-ci.sh <sha>` run are recorded on the PR. Unit suite: 9 files, **129 tests** (92 prior + 37).

## Scope note

Durable (database) re-verification of the T-006 chain — a changed intent creating a new stored revision,
a new approval row and a new operation row — needs the approval service and is re-run in M03/M04
integration tests. This PR is domain-only, like M00.
