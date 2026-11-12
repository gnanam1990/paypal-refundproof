# M04 PayPal execution and reconciliation

Status: SPECIFICATION_ONLY. Execution: NOT_RUN. Dependencies: M03. Owns FR-04, FR-05, NFR-03, INV-02, INV-03, T-007, T-009, T-010.

Integrate PayPal sandbox with credentials held server-side. Permanently bind one effectful operation and request ID to the approved revision, and persist the exact outbound amount/currency or intentional `FULL` semantic before sending. Add concurrent-worker and post-effect response-loss tests. Mere lookup absence remains unknown; permit a later provider operation only after durable NEVER_DISPATCHED evidence or a documented terminal non-application observation plus new revision and approval. Never invent provider capabilities.

## Dependency gate

Require M03 green approval tests, matching HEAD, a separately authorized PayPal sandbox credential setup, and verified current API behavior. Refuse production credentials.

## State machine and algorithm

Implement RefundOperation, ProviderAttempt, ProviderObservation, outbox claim, immutable PayPal request ID, exact outbound snapshot, SUBMITTING, OUTCOME_UNKNOWN, RECONCILING, CONFIRMED, PROVIDER_TERMINAL_NOT_APPLIED, EXHAUSTED, and durable NEVER_DISPATCHED evidence. Transport retry stays inside one operation.

## Failure-first and real-boundary proof

Make T-007, T-009, and T-010 fail. Race two workers, terminate before dispatch, drop a response after a real sandbox effect, restart during reconciliation, return temporary lookup absence, inject rate limits, and verify no duplicate. Real acceptance requires authoritative PayPal sandbox observation; a stub cannot turn green.

## Stop and handoff

Stop on undocumented provider semantics, production environment, secret leakage, no authoritative observation path, or ambiguous terminal non-application. Record exact commands, exits, test counts, red/green traces, sandbox object IDs in redacted form, HEAD, files, remaining NOT_RUN work, and cleanup. No push, PR, merge, deploy, publish, or submit.
