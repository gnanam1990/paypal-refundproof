# M02 AI proposal

Status: SPECIFICATION_ONLY. Execution: NOT_RUN. Dependencies: M01. Owns FR-01, NFR-02, INV-03, T-002.

Implement evidence admission, redaction, capture snapshot retrieval, schema-constrained model output, source citations, uncertainty, and human correction. First prove that injected instructions and unsupported fields are rejected. The model cannot approve or call PayPal. Store prompt/model/version and admitted evidence digests without secrets. Use real configured model calls for the acceptance path; label unavailable access BLOCKED.

## Dependency gate

Require M01 green persistence/restart evidence, matching HEAD, and an authenticated case/evidence API. Confirm the model provider and credential destination separately; never invent or write a secret.

## Records and algorithm

Create EvidenceAdmission, RedactionReport, ModelInvocation, ProposalCandidate, Citation, and ProposalRevision records. Admit only declared fields, delimit untrusted support text, validate a closed output schema, verify citation spans, and force human correction for uncertainty or capture mismatch.

## Test protocol and real proof

Make T-002 fail with prompt injection, uncited claims, extra fields, invalid money, oversized input, provider timeout, and restart after accepted evidence. Run a real configured model call through the normal service boundary; fixtures test determinism but do not satisfy acceptance.

## Stop and handoff

Stop on unavailable approved model access, privacy ambiguity, secret exposure, unsupported capture retrieval, or schema drift. Record exact commands, exits, counts, red/green evidence, model/version, redaction proof, HEAD, changed files, and remaining NOT_RUN items. No push, PR, deployment, publication, or submission.
