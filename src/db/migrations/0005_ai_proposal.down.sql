-- Rollback of 0005 AI proposal. Drops invocation and citation records (development databases only).
drop trigger if exists proposal_revisions_ai_guard on proposal_revisions;
drop function if exists refundproof_ai_revision_guard();
alter table proposal_revisions drop constraint if exists proposal_revisions_human_correction_explained;
alter table proposal_revisions drop constraint if exists proposal_revisions_ai_has_invocation;
alter table proposal_revisions drop constraint if exists proposal_revisions_snapshot_bound_fkey;
alter table proposal_revisions drop constraint if exists proposal_revisions_parent_bound_fkey;
alter table proposal_revisions drop constraint if exists proposal_revisions_invocation_bound_fkey;
alter table proposal_revisions drop constraint if exists proposal_revisions_case_tenant_id_key;
drop table if exists proposal_citations;
drop table if exists model_invocations;
drop function if exists refundproof_invocation_guard();
alter table evidence_artifacts drop constraint if exists evidence_artifacts_case_tenant_id_key;
drop trigger if exists capture_snapshots_immutable on capture_snapshots;
alter table capture_snapshots drop constraint if exists capture_snapshots_case_tenant_id_key;
