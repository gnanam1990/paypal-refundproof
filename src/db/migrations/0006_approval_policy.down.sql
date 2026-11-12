-- Rollback of 0006 approval policy (development databases only).
drop trigger if exists refund_operations_approval_guard on refund_operations;
drop function if exists refundproof_operation_approval_guard();
drop trigger if exists proposal_revisions_approval_guard on proposal_revisions;
drop function if exists refundproof_revision_approval_guard();
drop trigger if exists approvals_insert_guard on approvals;
drop function if exists refundproof_approval_insert_guard();
create or replace function refundproof_approval_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'refundproof: approvals are never deleted' using errcode = '55000';
  end if;
  if (new.id, new.tenant_id, new.revision_id, new.revision_digest, new.approval_digest, new.approver_id, new.decision,
      new.policy_version, new.full_refund_acknowledged, new.decided_at, new.expires_at, new.comment)
     is distinct from
     (old.id, old.tenant_id, old.revision_id, old.revision_digest, old.approval_digest, old.approver_id, old.decision,
      old.policy_version, old.full_refund_acknowledged, old.decided_at, old.expires_at, old.comment) then
    raise exception 'refundproof: approval decisions are immutable (only revocation may be recorded)' using errcode = '55000';
  end if;
  if old.revoked_at is not null then
    raise exception 'refundproof: approval already revoked' using errcode = '55000';
  end if;
  return new;
end $$;
alter table approvals drop constraint if exists approvals_policy_fkey;
alter table approvals drop constraint if exists approvals_request_fkey;
alter table approvals drop column if exists request_id;
drop table if exists approval_requests;
drop table if exists approval_policies;
