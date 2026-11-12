-- Rollback of 0001_core. Destroys all RefundProof data: only for empty/dev databases.
drop table if exists rate_limit_buckets, worker_heartbeats, outbox_jobs, state_transitions, audit_events cascade;
alter table if exists refund_operations drop constraint if exists refund_operations_confirmed_observation_id_fkey;
alter table if exists refund_operations drop constraint if exists refund_operations_terminal_observation_id_fkey;
drop table if exists provider_observations, provider_attempts, refund_operations, approvals, proposal_revisions,
  capture_snapshots, evidence_artifacts, cases, sessions, actors, tenants,
  operation_transition_rules, proposal_transition_rules cascade;
drop function if exists refundproof_reject_mutation, refundproof_operation_guard, refundproof_attempt_guard,
  refundproof_proposal_guard, refundproof_approval_guard cascade;
