-- 0005 AI proposal (M02). Records for model-assisted proposal generation, enforced in the database:
--   * capture snapshots are immutable evidence of what PayPal (or the labelled contract stub) reported;
--   * model_invocations record prompt version and digest, model requested and served, and the exact admitted
--     evidence digests; a row is created STARTED, finalized exactly once, and then frozen;
--   * citations are append-only, bound to their invocation's tenant and to evidence of the same case;
--   * AI-origin revisions must reference a finalized invocation of the same tenant and case.

alter table capture_snapshots add constraint capture_snapshots_case_tenant_id_key unique (case_id, tenant_id, id);
create trigger capture_snapshots_immutable before update or delete or truncate on capture_snapshots
  for each statement execute function refundproof_reject_mutation();

alter table evidence_artifacts add constraint evidence_artifacts_case_tenant_id_key unique (case_id, tenant_id, id);

create table model_invocations (
  id text primary key,
  tenant_id text not null,
  case_id text not null,
  capture_snapshot_id text not null,
  requested_by text not null,
  provider text not null check (provider in ('anthropic', 'local-fixture')),
  model_requested text not null check (length(model_requested) between 1 and 100),
  model_served text check (model_served is null or length(model_served) between 1 and 100),
  prompt_version text not null check (length(prompt_version) between 1 and 64),
  prompt_digest text not null check (prompt_digest ~ '^[0-9a-f]{64}$'),
  admitted_evidence jsonb not null check (jsonb_typeof(admitted_evidence) = 'array'),
  status text not null check (status in ('STARTED', 'SUCCEEDED', 'OUTPUT_REJECTED', 'PROVIDER_ERROR', 'TIMEOUT', 'ABANDONED')),
  output jsonb,
  output_digest text check (output_digest is null or output_digest ~ '^[0-9a-f]{64}$'),
  validation_errors jsonb not null default '[]'::jsonb check (jsonb_typeof(validation_errors) = 'array'),
  correction_reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(correction_reasons) = 'array'),
  provider_request_id text check (provider_request_id is null or length(provider_request_id) <= 200),
  stop_reason text check (stop_reason is null or length(stop_reason) <= 64),
  usage jsonb,
  error_class text check (error_class is null or length(error_class) <= 100),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, id),
  unique (case_id, tenant_id, id),
  foreign key (tenant_id, case_id) references cases (tenant_id, id),
  foreign key (case_id, tenant_id, capture_snapshot_id) references capture_snapshots (case_id, tenant_id, id),
  foreign key (tenant_id, requested_by) references actors (tenant_id, id),
  check ((status = 'STARTED') = (finished_at is null)),
  check (finished_at is null or finished_at >= started_at),
  check (status <> 'SUCCEEDED' or (output is not null and output_digest is not null))
);
create index model_invocations_case_idx on model_invocations (case_id, started_at desc);

create function refundproof_invocation_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'refundproof: model invocations are never deleted' using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'STARTED' then
      raise exception 'refundproof: model invocations are created STARTED' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.status <> 'STARTED' then
    raise exception 'refundproof: model invocation % is final', old.id using errcode = '55000';
  end if;
  if (new.id, new.tenant_id, new.case_id, new.capture_snapshot_id, new.requested_by, new.provider,
      new.model_requested, new.prompt_version, new.prompt_digest, new.admitted_evidence, new.started_at)
     is distinct from
     (old.id, old.tenant_id, old.case_id, old.capture_snapshot_id, old.requested_by, old.provider,
      old.model_requested, old.prompt_version, old.prompt_digest, old.admitted_evidence, old.started_at) then
    raise exception 'refundproof: model invocation inputs are immutable' using errcode = '55000';
  end if;
  return new;
end $$;

create trigger model_invocations_guard before insert or update or delete on model_invocations
  for each row execute function refundproof_invocation_guard();
create trigger model_invocations_no_truncate before truncate on model_invocations
  for each statement execute function refundproof_reject_mutation();

create table proposal_citations (
  id text primary key,
  tenant_id text not null,
  case_id text not null,
  invocation_id text not null,
  claim text not null check (claim in ('AMOUNT', 'REASON', 'CAPTURE_MATCH', 'NOTE_TO_PAYER')),
  evidence_label text not null check (evidence_label ~ '^E[0-9]{1,3}$'),
  evidence_id text,
  quote text not null check (length(quote) between 1 and 500),
  start_offset integer check (start_offset is null or start_offset >= 0),
  end_offset integer,
  verified boolean not null,
  failure text check (failure is null or length(failure) <= 200),
  created_at timestamptz not null default now(),
  foreign key (case_id, tenant_id, invocation_id) references model_invocations (case_id, tenant_id, id),
  foreign key (case_id, tenant_id, evidence_id) references evidence_artifacts (case_id, tenant_id, id),
  check (verified = (evidence_id is not null and start_offset is not null and end_offset > start_offset
                     and failure is null))
);
create index proposal_citations_invocation_idx on proposal_citations (invocation_id);
create trigger proposal_citations_append_only before update or delete or truncate on proposal_citations
  for each statement execute function refundproof_reject_mutation();

-- Revisions: an AI revision names its finalized invocation; lineage and invocation stay inside the tenant/case.
alter table proposal_revisions add constraint proposal_revisions_case_tenant_id_key unique (case_id, tenant_id, id);
alter table proposal_revisions add constraint proposal_revisions_invocation_bound_fkey
  foreign key (case_id, tenant_id, model_invocation_id) references model_invocations (case_id, tenant_id, id);
alter table proposal_revisions add constraint proposal_revisions_parent_bound_fkey
  foreign key (case_id, tenant_id, parent_revision_id) references proposal_revisions (case_id, tenant_id, id);
alter table proposal_revisions add constraint proposal_revisions_snapshot_bound_fkey
  foreign key (case_id, tenant_id, capture_snapshot_id) references capture_snapshots (case_id, tenant_id, id);
alter table proposal_revisions add constraint proposal_revisions_ai_has_invocation
  check (origin <> 'AI' or model_invocation_id is not null);
alter table proposal_revisions add constraint proposal_revisions_human_correction_explained
  check (origin <> 'HUMAN' or parent_revision_id is null or (explanation is not null and length(explanation) between 1 and 2000));

create function refundproof_ai_revision_guard() returns trigger language plpgsql as $$
declare
  inv record;
begin
  if new.origin = 'AI' then
    select status into inv from model_invocations where id = new.model_invocation_id;
    if inv.status is distinct from 'SUCCEEDED' then
      raise exception 'refundproof: an AI revision requires a SUCCEEDED model invocation' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger proposal_revisions_ai_guard before insert on proposal_revisions
  for each row execute function refundproof_ai_revision_guard();
