-- RefundProof core schema. Safety rules live here as constraints and triggers, not only in application code.

create table tenants (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table actors (
  id text primary key,
  tenant_id text not null references tenants (id),
  email text not null unique,
  display_name text not null,
  role text not null check (role in ('OPERATOR', 'APPROVER', 'ADMIN')),
  password_hash text not null,
  seeded boolean not null default false,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  actor_id text not null references actors (id),
  csrf_token text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_actor_idx on sessions (actor_id);

create table cases (
  id text primary key,
  tenant_id text not null references tenants (id),
  title text not null check (length(title) between 1 and 200),
  customer_ref text check (customer_ref is null or length(customer_ref) <= 200),
  status text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED', 'ESCALATED')),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, created_by) references actors (tenant_id, id)
);

create table evidence_artifacts (
  id text primary key,
  tenant_id text not null,
  case_id text not null,
  kind text not null check (kind in ('SUPPORT_MESSAGE', 'ORDER_NOTE', 'OPERATOR_NOTE')),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  redacted_text text not null,
  redacted_digest text not null check (redacted_digest ~ '^[0-9a-f]{64}$'),
  encrypted_original bytea not null,
  encryption_key_id text not null,
  original_bytes integer not null check (original_bytes between 1 and 65536),
  redaction_report jsonb not null,
  admitted_by text not null,
  admitted_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (case_id, digest),
  foreign key (tenant_id, case_id) references cases (tenant_id, id),
  foreign key (tenant_id, admitted_by) references actors (tenant_id, id)
);

create table capture_snapshots (
  id text primary key,
  tenant_id text not null,
  case_id text not null,
  capture_id text not null check (length(capture_id) between 1 and 64),
  status text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  order_id text,
  payee_merchant_id text,
  source text not null check (source in ('PAYPAL_SANDBOX', 'CONTRACT_STUB')),
  summary jsonb not null,
  fetched_at timestamptz not null default now(),
  fetched_by text not null,
  unique (tenant_id, id),
  foreign key (tenant_id, case_id) references cases (tenant_id, id),
  foreign key (tenant_id, fetched_by) references actors (tenant_id, id)
);
create index capture_snapshots_case_idx on capture_snapshots (case_id, capture_id, fetched_at desc);

create table proposal_revisions (
  id text primary key,
  tenant_id text not null,
  case_id text not null,
  revision_no integer not null check (revision_no >= 1),
  state text not null check (state in ('DRAFT', 'REVIEWABLE', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED')),
  content jsonb not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  capture_id text not null,
  amount_kind text not null check (amount_kind in ('EXACT', 'FULL')),
  capture_snapshot_id text,
  origin text not null check (origin in ('AI', 'HUMAN')),
  parent_revision_id text references proposal_revisions (id),
  model_invocation_id text,
  correction_reasons jsonb not null default '[]'::jsonb,
  explanation text,
  authored_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (case_id, revision_no),
  foreign key (tenant_id, case_id) references cases (tenant_id, id),
  foreign key (tenant_id, capture_snapshot_id) references capture_snapshots (tenant_id, id),
  foreign key (tenant_id, authored_by) references actors (tenant_id, id),
  -- a revision that still needs human correction can never leave DRAFT
  check (state not in ('REVIEWABLE', 'APPROVED') or jsonb_array_length(correction_reasons) = 0)
);
-- One live (approvable or approved) revision per case.
create unique index proposal_one_live_per_case on proposal_revisions (case_id)
  where state in ('DRAFT', 'REVIEWABLE', 'APPROVED');

create table approvals (
  id text primary key,
  tenant_id text not null,
  revision_id text not null,
  revision_digest text not null check (revision_digest ~ '^[0-9a-f]{64}$'),
  approval_digest text not null check (approval_digest ~ '^[0-9a-f]{64}$'),
  approver_id text not null,
  decision text not null check (decision in ('APPROVED', 'REJECTED')),
  policy_version text not null,
  full_refund_acknowledged boolean not null default false,
  decided_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  comment text,
  unique (tenant_id, id),
  foreign key (tenant_id, revision_id) references proposal_revisions (tenant_id, id),
  foreign key (tenant_id, approver_id) references actors (tenant_id, id),
  foreign key (tenant_id, revoked_by) references actors (tenant_id, id),
  check (expires_at > decided_at)
);
create unique index approvals_one_approved_per_revision on approvals (revision_id) where decision = 'APPROVED';

create table refund_operations (
  id text primary key,
  tenant_id text not null,
  case_id text not null,
  approved_revision_id text not null unique,
  approval_id text not null,
  capture_id text not null,
  paypal_request_id text not null unique,
  invoice_id text not null unique,
  custom_id text not null unique,
  amount_kind text not null check (amount_kind in ('EXACT', 'FULL')),
  outbound_snapshot jsonb not null,
  state text not null default 'READY' check (state in (
    'READY', 'SUBMITTING', 'CONFIRMED', 'OUTCOME_UNKNOWN', 'RECONCILING',
    'PROVIDER_TERMINAL_NOT_APPLIED', 'EXHAUSTED', 'CANCELLED_BEFORE_DISPATCH')),
  state_version integer not null default 0,
  never_dispatched_evidence jsonb,
  confirmed_observation_id text,
  terminal_observation_id text,
  refund_id text,
  next_reconcile_at timestamptz,
  reconcile_started_at timestamptz,
  escalated_at timestamptz,
  escalated_by text,
  escalation_note text,
  human_resolution text check (human_resolution is null or human_resolution in ('RESOLVED_OUTSIDE_SYSTEM', 'WRITTEN_OFF')),
  human_resolution_note text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (id, paypal_request_id),
  foreign key (tenant_id, case_id) references cases (tenant_id, id),
  foreign key (tenant_id, approved_revision_id) references proposal_revisions (tenant_id, id),
  foreign key (tenant_id, approval_id) references approvals (tenant_id, id),
  foreign key (tenant_id, created_by) references actors (tenant_id, id),
  foreign key (tenant_id, escalated_by) references actors (tenant_id, id)
);
-- At most one operation per case that may hold (or be about to hold) a PayPal effect.
create unique index operations_one_effect_per_case on refund_operations (case_id)
  where state not in ('PROVIDER_TERMINAL_NOT_APPLIED', 'CANCELLED_BEFORE_DISPATCH');
-- At most one unresolved operation per capture across cases.
create unique index operations_one_unresolved_per_capture on refund_operations (tenant_id, capture_id)
  where state in ('READY', 'SUBMITTING', 'OUTCOME_UNKNOWN', 'RECONCILING', 'EXHAUSTED');

create table provider_attempts (
  id text primary key,
  operation_id text not null,
  paypal_request_id text not null,
  attempt_no integer not null check (attempt_no between 1 and 100),
  phase text not null check (phase in ('DISPATCHING', 'RESPONDED', 'NOT_SENT', 'LOST')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  http_status integer,
  error_class text,
  correlation_id text not null,
  request_meta jsonb not null default '{}'::jsonb,
  response_meta jsonb not null default '{}'::jsonb,
  unique (operation_id, attempt_no),
  -- every attempt carries the operation's immutable request id
  foreign key (operation_id, paypal_request_id) references refund_operations (id, paypal_request_id)
);

create table provider_observations (
  id text primary key,
  tenant_id text not null references tenants (id),
  operation_id text references refund_operations (id),
  capture_id text not null,
  kind text not null check (kind in ('REFUND_RESPONSE', 'REFUND_LOOKUP', 'CAPTURE_LOOKUP', 'ORDER_LOOKUP', 'ERROR_RESPONSE')),
  classification text not null check (classification in (
    'REFUND_COMPLETED', 'REFUND_PENDING', 'REFUND_TERMINAL_NOT_APPLIED', 'REQUEST_REJECTED_TERMINAL',
    'MATCH_ABSENT', 'CAPTURE_STATE', 'AMBIGUOUS', 'NOT_PROCESSED_RETRYABLE')),
  source text not null check (source in ('PAYPAL_SANDBOX', 'CONTRACT_STUB')),
  http_status integer,
  paypal_debug_id text,
  refund_id text,
  refund_status text,
  summary jsonb not null,
  correlation_id text not null,
  observed_at timestamptz not null default now()
);
create index provider_observations_op_idx on provider_observations (operation_id, observed_at);

alter table refund_operations
  add foreign key (confirmed_observation_id) references provider_observations (id),
  add foreign key (terminal_observation_id) references provider_observations (id);

create table audit_events (
  id bigserial primary key,
  tenant_id text references tenants (id),
  actor_id text references actors (id),
  event_type text not null,
  subject_type text not null,
  subject_id text not null,
  outcome text not null default 'OK' check (outcome in ('OK', 'DENIED', 'ERROR')),
  details jsonb not null default '{}'::jsonb,
  correlation_id text,
  created_at timestamptz not null default now()
);
create index audit_events_subject_idx on audit_events (subject_type, subject_id, id);

create table state_transitions (
  id bigserial primary key,
  tenant_id text not null,
  machine text not null check (machine in ('proposal', 'operation')),
  subject_id text not null,
  from_state text,
  to_state text not null,
  created_at timestamptz not null default now()
);
create index state_transitions_subject_idx on state_transitions (subject_id, id);

create table outbox_jobs (
  id bigserial primary key,
  tenant_id text references tenants (id),
  kind text not null check (kind in ('DISPATCH_REFUND', 'RECONCILE_REFUND', 'SELFTEST')),
  operation_id text references refund_operations (id),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'PENDING' check (state in ('PENDING', 'RUNNING', 'DONE', 'DEAD')),
  run_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 20 check (max_attempts between 1 and 100),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'SELFTEST' or operation_id is not null)
);
create unique index outbox_one_active_job on outbox_jobs (kind, operation_id)
  where state in ('PENDING', 'RUNNING') and operation_id is not null;
create index outbox_claim_idx on outbox_jobs (run_at) where state = 'PENDING';
create index outbox_lease_idx on outbox_jobs (lease_expires_at) where state = 'RUNNING';

create table worker_heartbeats (
  worker_id text primary key,
  pid integer not null,
  started_at timestamptz not null,
  last_seen_at timestamptz not null
);

create table rate_limit_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  hits integer not null,
  primary key (bucket_key, window_start)
);

-- ---------------------------------------------------------------- transition tables (mirror src/domain/states.ts)

create table operation_transition_rules (from_state text not null, to_state text not null, evidence text, primary key (from_state, to_state));
insert into operation_transition_rules values
  ('READY', 'SUBMITTING', null),
  ('READY', 'CANCELLED_BEFORE_DISPATCH', 'NEVER_DISPATCHED'),
  ('SUBMITTING', 'CONFIRMED', 'PROVIDER_CONFIRMED_OBSERVATION'),
  ('SUBMITTING', 'OUTCOME_UNKNOWN', null),
  ('SUBMITTING', 'RECONCILING', 'PROVIDER_PENDING_OBSERVATION'),
  ('SUBMITTING', 'PROVIDER_TERMINAL_NOT_APPLIED', 'PROVIDER_TERMINAL_OBSERVATION'),
  ('SUBMITTING', 'READY', 'NOT_SENT'),
  ('SUBMITTING', 'CANCELLED_BEFORE_DISPATCH', 'NEVER_DISPATCHED'),
  ('OUTCOME_UNKNOWN', 'RECONCILING', null),
  ('RECONCILING', 'CONFIRMED', 'PROVIDER_CONFIRMED_OBSERVATION'),
  ('RECONCILING', 'PROVIDER_TERMINAL_NOT_APPLIED', 'PROVIDER_TERMINAL_OBSERVATION'),
  ('RECONCILING', 'EXHAUSTED', null),
  ('EXHAUSTED', 'RECONCILING', null);

create table proposal_transition_rules (from_state text not null, to_state text not null, primary key (from_state, to_state));
insert into proposal_transition_rules values
  ('DRAFT', 'REVIEWABLE'), ('DRAFT', 'SUPERSEDED'),
  ('REVIEWABLE', 'APPROVED'), ('REVIEWABLE', 'REJECTED'), ('REVIEWABLE', 'EXPIRED'), ('REVIEWABLE', 'SUPERSEDED'),
  ('APPROVED', 'REJECTED'), ('APPROVED', 'EXPIRED');

-- ---------------------------------------------------------------- triggers

create function refundproof_reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'refundproof: % is append-only', tg_table_name using errcode = '55000';
end $$;

create trigger audit_events_append_only before update or delete or truncate on audit_events
  for each statement execute function refundproof_reject_mutation();
create trigger state_transitions_append_only before update or delete or truncate on state_transitions
  for each statement execute function refundproof_reject_mutation();
create trigger evidence_immutable before update or delete or truncate on evidence_artifacts
  for each statement execute function refundproof_reject_mutation();
create trigger observations_immutable before update or delete or truncate on provider_observations
  for each statement execute function refundproof_reject_mutation();
create trigger transition_rules_immutable before insert or update or delete on operation_transition_rules
  for each statement execute function refundproof_reject_mutation();
create trigger proposal_rules_immutable before insert or update or delete on proposal_transition_rules
  for each statement execute function refundproof_reject_mutation();

create function refundproof_operation_guard() returns trigger language plpgsql as $$
declare
  rule_evidence text;
  rule_found boolean;
  obs record;
begin
  if tg_op = 'DELETE' then
    raise exception 'refundproof: refund operations are never deleted' using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'READY' then
      raise exception 'refundproof: operations start READY' using errcode = '23514';
    end if;
    insert into state_transitions (tenant_id, machine, subject_id, from_state, to_state)
      values (new.tenant_id, 'operation', new.id, null, new.state);
    return new;
  end if;
  if (new.id, new.tenant_id, new.case_id, new.approved_revision_id, new.approval_id, new.capture_id,
      new.paypal_request_id, new.invoice_id, new.custom_id, new.amount_kind, new.outbound_snapshot,
      new.created_by, new.created_at)
     is distinct from
     (old.id, old.tenant_id, old.case_id, old.approved_revision_id, old.approval_id, old.capture_id,
      old.paypal_request_id, old.invoice_id, old.custom_id, old.amount_kind, old.outbound_snapshot,
      old.created_by, old.created_at) then
    raise exception 'refundproof: operation identity and outbound snapshot are immutable' using errcode = '55000';
  end if;
  if old.refund_id is not null and new.refund_id is distinct from old.refund_id then
    raise exception 'refundproof: refund id is immutable once observed' using errcode = '55000';
  end if;
  if new.state is distinct from old.state then
    select true, evidence into rule_found, rule_evidence from operation_transition_rules
      where from_state = old.state and to_state = new.state;
    if rule_found is null then
      raise exception 'refundproof: invalid operation transition % -> %', old.state, new.state using errcode = '23514';
    end if;
    if rule_evidence = 'PROVIDER_CONFIRMED_OBSERVATION' then
      select * into obs from provider_observations where id = new.confirmed_observation_id;
      if obs.id is null or obs.operation_id <> new.id or obs.classification <> 'REFUND_COMPLETED' then
        raise exception 'refundproof: CONFIRMED requires a matching REFUND_COMPLETED observation' using errcode = '23514';
      end if;
    elsif rule_evidence = 'PROVIDER_TERMINAL_OBSERVATION' then
      select * into obs from provider_observations where id = new.terminal_observation_id;
      if obs.id is null or obs.operation_id <> new.id
         or obs.classification not in ('REFUND_TERMINAL_NOT_APPLIED', 'REQUEST_REJECTED_TERMINAL') then
        raise exception 'refundproof: terminal non-application requires a terminal observation' using errcode = '23514';
      end if;
    elsif rule_evidence = 'PROVIDER_PENDING_OBSERVATION' then
      if not exists (select 1 from provider_observations where operation_id = new.id and classification = 'REFUND_PENDING') then
        raise exception 'refundproof: RECONCILING from SUBMITTING requires a REFUND_PENDING observation' using errcode = '23514';
      end if;
    elsif rule_evidence = 'NEVER_DISPATCHED' then
      if new.never_dispatched_evidence is null
         or exists (select 1 from provider_attempts where operation_id = new.id and phase <> 'NOT_SENT') then
        raise exception 'refundproof: cancellation requires durable never-dispatched evidence' using errcode = '23514';
      end if;
    elsif rule_evidence = 'NOT_SENT' then
      if not exists (select 1 from provider_attempts where operation_id = new.id)
         or exists (select 1 from provider_attempts where operation_id = new.id and phase <> 'NOT_SENT') then
        raise exception 'refundproof: SUBMITTING -> READY requires every attempt to be NOT_SENT' using errcode = '23514';
      end if;
    end if;
    new.state_version := old.state_version + 1;
    insert into state_transitions (tenant_id, machine, subject_id, from_state, to_state)
      values (new.tenant_id, 'operation', new.id, old.state, new.state);
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger refund_operations_guard before insert or update or delete on refund_operations
  for each row execute function refundproof_operation_guard();

create function refundproof_attempt_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'refundproof: provider attempts are never deleted' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    if (new.id, new.operation_id, new.paypal_request_id, new.attempt_no, new.started_at, new.correlation_id)
       is distinct from (old.id, old.operation_id, old.paypal_request_id, old.attempt_no, old.started_at, old.correlation_id) then
      raise exception 'refundproof: attempt identity is immutable' using errcode = '55000';
    end if;
    -- An attempt that may have reached PayPal can never be rewritten as NOT_SENT.
    if old.phase <> 'DISPATCHING' and new.phase is distinct from old.phase then
      raise exception 'refundproof: attempt phase % is final', old.phase using errcode = '55000';
    end if;
  end if;
  return new;
end $$;

create trigger provider_attempts_guard before update or delete on provider_attempts
  for each row execute function refundproof_attempt_guard();

create function refundproof_proposal_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'refundproof: proposal revisions are never deleted' using errcode = '55000';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'refundproof: revisions start DRAFT' using errcode = '23514';
    end if;
    insert into state_transitions (tenant_id, machine, subject_id, from_state, to_state)
      values (new.tenant_id, 'proposal', new.id, null, new.state);
    return new;
  end if;
  if (new.id, new.tenant_id, new.case_id, new.revision_no, new.content, new.digest, new.capture_id, new.amount_kind,
      new.capture_snapshot_id, new.origin, new.parent_revision_id, new.model_invocation_id, new.correction_reasons,
      new.explanation, new.authored_by, new.created_at)
     is distinct from
     (old.id, old.tenant_id, old.case_id, old.revision_no, old.content, old.digest, old.capture_id, old.amount_kind,
      old.capture_snapshot_id, old.origin, old.parent_revision_id, old.model_invocation_id, old.correction_reasons,
      old.explanation, old.authored_by, old.created_at) then
    raise exception 'refundproof: proposal revisions are immutable; create a new revision' using errcode = '55000';
  end if;
  if new.state is distinct from old.state then
    if not exists (select 1 from proposal_transition_rules where from_state = old.state and to_state = new.state) then
      raise exception 'refundproof: invalid proposal transition % -> %', old.state, new.state using errcode = '23514';
    end if;
    if old.state = 'APPROVED' and exists (
         select 1 from refund_operations o where o.approved_revision_id = new.id
         and not (o.state = 'CANCELLED_BEFORE_DISPATCH')) then
      raise exception 'refundproof: an approved revision with a live operation cannot be revoked or expired' using errcode = '23514';
    end if;
    insert into state_transitions (tenant_id, machine, subject_id, from_state, to_state)
      values (new.tenant_id, 'proposal', new.id, old.state, new.state);
  end if;
  return new;
end $$;

create trigger proposal_revisions_guard before insert or update or delete on proposal_revisions
  for each row execute function refundproof_proposal_guard();

create function refundproof_approval_guard() returns trigger language plpgsql as $$
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

create trigger approvals_guard before update or delete on approvals
  for each row execute function refundproof_approval_guard();

create trigger refund_operations_no_truncate before truncate on refund_operations
  for each statement execute function refundproof_reject_mutation();

create trigger proposal_revisions_no_truncate before truncate on proposal_revisions
  for each statement execute function refundproof_reject_mutation();

create trigger approvals_no_truncate before truncate on approvals
  for each statement execute function refundproof_reject_mutation();

create trigger provider_attempts_no_truncate before truncate on provider_attempts
  for each statement execute function refundproof_reject_mutation();
