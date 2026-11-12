# M00 contracts

Status: SPECIFICATION_ONLY. Execution: NOT_RUN. Dependencies: none. Owns FR-03, NFR-03, INV-02, T-005, T-006.

Inspect the repository before editing. Define canonical IDs, money types, proposal/operation states, transition guards, provider request identity, and JSON schemas. Write failing property tests for same-intent retry and changed-intent separation, then implement the minimum domain kernel. Prove database-independent determinism. Record commands, exits, counts, redacted evidence, commit SHA, and risks. Do not perform external actions.

## Dependency gate

Confirm repository instructions, current HEAD, dirty files, language/toolchain, and that no prior domain contract conflicts. No earlier module is required. If an existing money or idempotency type exists, adapt rather than duplicate it and record the decision.

## Records and algorithm

Specify ProposalRevision, ApprovalIdentity, RefundOperation, ProviderAttempt, Money, and canonical digest inputs. The algorithm must distinguish same-intent transport retry from a changed business intent and make the latter impossible under the earlier identity.

## Test protocol and proof

Capture red evidence for T-005 and T-006 before implementation. Add property, concurrency-model, serialization, overflow, currency, and invalid-transition negatives. Run the focused suite twice to show deterministic identities. This module has no PayPal boundary; its proof is deterministic domain behavior only.

## Stop and handoff

Stop on ambiguous money semantics, unstable canonicalization, repository conflict, or any need for provider behavior. Handoff must list exact commands, exit codes, test counts, red and green evidence, HEAD SHA, changed files, decisions, risks, and every remaining test/module as NOT_RUN. Local commit only; no push, PR, merge, deploy, publish, or submit.
