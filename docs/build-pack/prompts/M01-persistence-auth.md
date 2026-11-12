# M01 persistence and authorization

Status: SPECIFICATION_ONLY. Execution: NOT_RUN. Dependencies: M00. Owns FR-06, NFR-01, INV-03, T-001, T-008.

Add tenant-scoped identities, operator and approver roles, migrations, durable records, transactional scheduling, and append-only audit events. Start with failing persistence and restart tests. Enforce database constraints rather than UI convention. Recover accepted work after process termination without manual repair. Record actual evidence and stop on unsafe migration or ambiguous repository ownership.

## Dependency gate

Require M00 handoff, green T-005/T-006, matching HEAD, and approved schema direction. Re-read migration and authentication conventions before editing.

## Records and states

Persist Case, EvidenceArtifact, ProposalRevision, Approval, RefundOperation, ProviderAttempt, ProviderObservation, AuditEvent, tenant, and actor role. Use transactions, a permanent unique approved-revision operation constraint, durable queue/outbox identity, and append-only transition records.

## Test protocol and proof

First make T-001 and T-008 fail. Add cross-tenant denial, role denial, concurrent insert, rollback, migration-up/down where supported, abrupt worker termination, and database restart tests. Real proof is process/database restart against the selected repository database, not an in-memory substitute.

## Stop and handoff

Stop for destructive migration risk, missing tenant identity, unverifiable rollback, or inconsistent M00 digests. Report exact commands, exits, test counts, red/green evidence, migration names, HEAD, changed files, remaining NOT_RUN work, and rollback. Do not perform remote or publication actions.
