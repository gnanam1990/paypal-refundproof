-- 0006 approval policy (M03). Approval authority is enforced by the database, not only by services:
--   * approval policies are immutable versioned records; every approval names one;
--   * an approval request records who asked, for which exact revision digest;
--   * an approval decision must match the revision's stored digest while it is REVIEWABLE, come from an
--     APPROVER or ADMIN of the same tenant who neither authored the revision nor requested the approval, carry
--     explicit FULL-refund consent when the revision refunds the full capture, and expire within the policy TTL;
--   * a revision becomes APPROVED only with such a live approval, and an operation can only be created from an
--     APPROVED revision whose approval is unrevoked, unexpired and digest-equal (INV-01).

create table approval_policies (
  version text primary key check (length(version) between 1 and 64),
  definition jsonb not null,
  created_at timestamptz not null default now()
);
create trigger approval_policies_immutable before update or delete or truncate on approval_policies
  for each statement execute function refundproof_reject_mutation();

-- policy-v1: approvals live 60 minutes; separation of duties; EXACT amounts above the per-currency limit (minor
-- units) and every currency without a limit need an ADMIN approver; FULL needs explicit consent.
insert into approval_policies (version, definition) values ('policy-v1', '{
  "approvalTtlMinutes": 60,
  "separationOfDuties": true,
  "fullRefundRequiresConsent": true,
  "adminRequiredAboveMinor": {"USD": 50000, "EUR": 50000, "GBP": 40000, "CAD": 70000, "AUD": 75000, "JPY": 75000}
}'::jsonb);

create table approval_requests (
  id text primary key,
  tenant_id text not null,
  case_id text not null,
  revision_id text not null,
  revision_digest text not null check (revision_digest ~ '^[0-9a-f]{64}$'),
  requested_by text not null,
  note text check (note is null or length(note) <= 1000),
  requested_at timestamptz not null default now(),
  unique (revision_id),
  unique (tenant_id, id),
  foreign key (case_id, tenant_id, revision_id) references proposal_revisions (case_id, tenant_id, id),
  foreign key (tenant_id, requested_by) references actors (tenant_id, id)
);
create trigger approval_requests_append_only before update or delete or truncate on approval_requests
  for each statement execute function refundproof_reject_mutation();

alter table approvals add column request_id text;
alter table approvals add constraint approvals_request_fkey
  foreign key (tenant_id, request_id) references approval_requests (tenant_id, id);
alter table approvals add constraint approvals_policy_fkey
  foreign key (policy_version) references approval_policies (version) not valid;

-- Decisions stay immutable (only one revocation may be recorded); the request link is part of the decision.
create or replace function refundproof_approval_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'refundproof: approvals are never deleted' using errcode = '55000';
  end if;
  if (new.id, new.tenant_id, new.revision_id, new.revision_digest, new.approval_digest, new.approver_id, new.decision,
      new.policy_version, new.full_refund_acknowledged, new.decided_at, new.expires_at, new.comment, new.request_id)
     is distinct from
     (old.id, old.tenant_id, old.revision_id, old.revision_digest, old.approval_digest, old.approver_id, old.decision,
      old.policy_version, old.full_refund_acknowledged, old.decided_at, old.expires_at, old.comment, old.request_id) then
    raise exception 'refundproof: approval decisions are immutable (only revocation may be recorded)' using errcode = '55000';
  end if;
  if old.revoked_at is not null then
    raise exception 'refundproof: approval already revoked' using errcode = '55000';
  end if;
  return new;
end $$;

create function refundproof_approval_insert_guard() returns trigger language plpgsql as $$
declare
  rev record;
  req record;
  pol record;
  approver_role text;
begin
  select * into rev from proposal_revisions where id = new.revision_id for update;
  if rev.id is null or rev.tenant_id <> new.tenant_id then
    raise exception 'refundproof: approval names an unknown revision' using errcode = '23503';
  end if;
  if rev.state <> 'REVIEWABLE' then
    raise exception 'refundproof: only a REVIEWABLE revision can be decided (is %)', rev.state using errcode = '23514';
  end if;
  if new.revision_digest <> rev.digest then
    raise exception 'refundproof: approval digest does not match the revision (stale approval)' using errcode = '23514';
  end if;
  select role into approver_role from actors where id = new.approver_id and tenant_id = new.tenant_id and not disabled;
  if approver_role is null or approver_role not in ('APPROVER', 'ADMIN') then
    raise exception 'refundproof: approver must be an APPROVER or ADMIN of the tenant' using errcode = '23514';
  end if;
  select * into pol from approval_policies where version = new.policy_version;
  if pol.version is null or new.policy_version <> rev.content->>'policyVersion' then
    raise exception 'refundproof: approval policy must be the revision''s policy version' using errcode = '23514';
  end if;
  if (pol.definition->>'separationOfDuties')::boolean then
    if new.approver_id = rev.authored_by then
      raise exception 'refundproof: the author of a revision cannot decide it' using errcode = '23514';
    end if;
    select * into req from approval_requests where id = new.request_id;
    if req.id is not null and req.requested_by = new.approver_id then
      raise exception 'refundproof: the requester of an approval cannot decide it' using errcode = '23514';
    end if;
  end if;
  if new.decision = 'APPROVED' then
    if new.request_id is null then
      raise exception 'refundproof: an approval decides a recorded approval request' using errcode = '23514';
    end if;
    if rev.amount_kind = 'FULL' and (pol.definition->>'fullRefundRequiresConsent')::boolean
       and not new.full_refund_acknowledged then
      raise exception 'refundproof: a FULL refund requires explicit consent' using errcode = '23514';
    end if;
    if new.expires_at > new.decided_at + make_interval(mins => (pol.definition->>'approvalTtlMinutes')::int) then
      raise exception 'refundproof: approval expiry exceeds the policy TTL' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger approvals_insert_guard before insert on approvals
  for each row execute function refundproof_approval_insert_guard();

-- A revision becomes APPROVED only together with a live approval of its exact digest.
create function refundproof_revision_approval_guard() returns trigger language plpgsql as $$
begin
  if new.state = 'APPROVED' and old.state is distinct from 'APPROVED' then
    if not exists (select 1 from approvals a where a.revision_id = new.id and a.decision = 'APPROVED'
                   and a.revoked_at is null and a.expires_at > now() and a.revision_digest = new.digest) then
      raise exception 'refundproof: a revision is APPROVED only with a live approval of its digest' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger proposal_revisions_approval_guard before update on proposal_revisions
  for each row execute function refundproof_revision_approval_guard();

-- INV-01: an operation is created only from the exact, live, approved revision.
create function refundproof_operation_approval_guard() returns trigger language plpgsql as $$
declare
  ap record;
  rev record;
begin
  select * into ap from approvals where id = new.approval_id;
  select * into rev from proposal_revisions where id = new.approved_revision_id;
  if ap.id is null or rev.id is null or ap.revision_id <> rev.id or ap.decision <> 'APPROVED'
     or ap.revoked_at is not null or ap.expires_at <= now() or rev.state <> 'APPROVED'
     or ap.revision_digest <> rev.digest or ap.tenant_id <> new.tenant_id then
    raise exception 'refundproof: an operation requires the exact, live, approved revision' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger refund_operations_approval_guard before insert on refund_operations
  for each row execute function refundproof_operation_approval_guard();
