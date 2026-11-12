# M03 approval policy

Status: SPECIFICATION_ONLY. Execution: NOT_RUN. Dependencies: M02. Owns FR-02, NFR-02, INV-01, T-003, T-004.

Implement canonical proposal revision digests, approver authorization, expiry, rejection, revocation, amount limits, and explicit full-refund consent. Begin with failing stale-approval and omitted-amount tests. Any changed bound field must create a new revision. Surface exact approval facts in API and UI contracts. Do not allow the same actor to bypass configured separation rules.

## Dependency gate

Require M02 accepted proposal records, green injection/schema tests, matching HEAD, and stable canonical digest inputs. Confirm actor-role and policy-version sources.

## Records and state transitions

Implement ApprovalRequest, ApprovalDecision, policy revision, expiry, rejection, revocation, and immutable bound digest. Bind capture, exact amount/currency or explicit FULL semantic, reason, evidence, proposal revision, approver, and policy. Recheck immediately before operation creation.

## Test protocol and proof

Make T-003 and T-004 fail first. Add stale revision, expired decision, unauthorized approver, forbidden self-approval, concurrent edit/approve, amount substitution, currency substitution, accidental omitted payload, and restart tests. Prove API and rendered approval facts match the stored digest.

## Stop and handoff

Stop on ambiguous approval authority, policy conflict, mutable digest field, or inability to distinguish FULL from omitted amount. Record exact commands, exits, counts, red/green evidence, HEAD, files, policy decisions, and remaining NOT_RUN work. No external actions.
