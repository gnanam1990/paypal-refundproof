# Technical design

## Architecture and trust boundaries

Use a web application, authenticated control API, PostgreSQL, durable worker queue, AI proposal service, PayPal sandbox adapter, reconciler, and append-only evidence ledger. The browser never receives PayPal credentials. The model receives only a minimal redacted support excerpt and provider metadata required for proposal generation; its output is untrusted structured input.

## Data model

Core records are Case, EvidenceArtifact, CaptureSnapshot, ProposalRevision, Approval, RefundOperation, ProviderAttempt, ProviderObservation, and AuditEvent. IDs are server-generated. Proposal revision digest covers capture ID, exact outbound amount/currency semantics, reason, evidence digests, and policy version. `approved_revision_id` is permanently unique for effectful operations. PayPal request ID is immutable once allocated; network retries create attempts under the same operation. The retained redacted request snapshot proves whether an exact amount was sent or the explicit `FULL` semantic was intentionally used.

## State machines

Proposal: `DRAFT -> REVIEWABLE -> APPROVED | REJECTED | EXPIRED`; any change creates a new DRAFT. Operation: `READY -> SUBMITTING -> CONFIRMED | OUTCOME_UNKNOWN -> RECONCILING -> CONFIRMED | PROVIDER_TERMINAL_NOT_APPLIED | EXHAUSTED`. `NEVER_DISPATCHED` is not a provider state: it is durable outbox evidence that no network attempt began. A missing lookup result remains OUTCOME_UNKNOWN or EXHAUSTED. A later provider operation requires a new proposal revision and approval and is allowed only after NEVER_DISPATCHED evidence or a specifically documented terminal PayPal non-application observation.

## Provider behavior

Set explicit connect and total deadlines. Persist the operation, exact outbound payload semantics, and request ID before the network call. Record the HTTP exchange metadata without secrets. On connection ambiguity or lost response, commit OUTCOME_UNKNOWN. Reconcile through authoritative PayPal refund/capture or transaction observations with exponential backoff and a finite deadline; do not invent a lookup API. Temporary absence is never terminal proof.

## AI behavior

The model returns a schema-validated proposal with citations into admitted evidence. Unsupported fields, uncited claims, or uncertain capture matching force human correction. The model cannot call the PayPal adapter and cannot produce an approval.

## Deployment

Use separate web and worker processes, managed PostgreSQL, encrypted secret storage, TLS, structured logs, health checks, migrations with rollback, and sandbox-only environment guards. Production credentials are an unsupported configuration until a later security review and explicit authorization.
