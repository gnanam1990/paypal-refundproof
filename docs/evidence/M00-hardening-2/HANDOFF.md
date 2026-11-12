# M00 post-merge corrective hardening #2

Status: **CORRECTIVE**. Independent post-merge review of merge `af73ca0` (PR #2, head `442ec3f`):
REQUEST CHANGES. This PR closes those findings. Merged history is not rewritten; M01 stays held.
Branch `m00-hardening-2` from `main@af73ca0`.

## Findings → requirement → tests → fix

| ID | Finding (on af73ca0) | Requirement | Red test (`test/property/m00-hardening-3.property.test.ts`) | Fix |
| --- | --- | --- | --- | --- |
| F1 (HIGH) | `decodeRevisionContent` treated every non-EXACT or missing `kind` as FULL and silently dropped closed-schema violations: `kind: BOGUS` decoded as FULL USD 99.00; missing kind, EXACT + `captureAmount`, extra top-level and nested fields all accepted, while Ajv and zod reject them. H1 parity was not fully closed. | FR-03, T-004 (no accidental FULL), INV-03, exported-schema/runtime parity | 21 regression documents (BOGUS/missing/null/lowercase kind, EXACT+captureAmount, FULL+amount, missing payloads, extra fields at three depths, missing fields, wrong leaf types, `__proto__` key, null/array/string documents) asserted rejected by domain **and** Ajv **and** zod; valid EXACT/FULL accepted by all three; 3 000-run structural-mutation differential (add/delete/replace keys at five depths, kind mutation, EXACT↔FULL flip) requiring domain verdict = Ajv verdict = zod verdict; in-memory normalizer rejects an unknown kind | `src/domain/proposal.ts`: `decodeRevisionContent(w: unknown)` validates the complete closed wire shape (plain objects, exact key sets at every level, typed leaves) and decodes the amount through an exhaustive `switch` whose `default` throws; `normalizeRevisionContent` and `encodeRevisionContent` use exhaustive switches (encode has a `never` check) |
| F2 (MED) | `deriveOperationIdentity` accepted whitespace-only tenant/revision ids and a 1 000 000-character tenant id — operation identities no approval can legally bind | FR-03, INV-01, INV-02 | 9 bad ids × {tenantId, revisionId} rejected; 2 000-run agreement property: proposal normalizer, `approvalDigest` and `deriveOperationIdentity` accept exactly the same tenant ids; `approvalDigest` and `deriveOperationIdentity` accept exactly the same revision ids | `src/domain/identity.ts`: shared `isBoundId` rule on both ids |
| F3 | Dev-only audit findings: **critical** tinypool GHSA-5gmw-xhrv-c9v3 and GHSA-85c8-ppgw-ccpr (via vitest 3.2.7); moderate vitest/@vitest/mocker GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8; moderate minimatch GHSA-g3hv-75wg-m249 (via typescript-eslint) | SECURITY (supply chain) | `pnpm audit` before: 2 critical, 4 moderate ([`audit-before.json`](audit-before.json)) | vitest 3.2.7 → 4.1.12 (patched line); `pnpm-workspace.yaml` override `minimatch@>=7.0.0 <11.0.1 → ^11.0.1` (no typescript-estree release depends on a patched minimatch yet; lint verified to still catch planted violations). `pnpm audit` after: **No known vulnerabilities found**. Audit added as a gate to CI, `verify:m00` and `scripts/local-ci.sh` |
| F4 | `docs/BUILD-STATUS.md` was stale (all modules NOT_RUN) | DELIVERY | — | rewritten with merged PRs, held M01, CI_BLOCKED, BLOCKED integrations, per-test status |

Red before fixes: [`red.txt`](red.txt) — **37 failed / 7 passed** of 44 new tests.

Mutation checks after fixes (originals restored):

- decoder `default` returning FULL instead of throwing → **5 failed**.
- operation identity back to truthiness-only id checks → **18 failed**.

One fuzzer counterexample during development was a harness bug (a `kind` mutation applied after `amount` was
deleted threw inside the test); the harness now guards it. It was not a product disagreement.

## Green evidence

Unit suite: 11 files, **195 tests**, three consecutive runs with fresh fuzzer seeds. `pnpm audit
--audit-level=low` clean. Full gate and the exact clean-clone run are recorded on the PR.
