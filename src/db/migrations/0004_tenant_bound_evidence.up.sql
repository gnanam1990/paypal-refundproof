-- 0004 tenant-bound evidence (M01 corrective, Blocker 3).
-- 0001 gave provider_observations independent foreign keys on tenant_id and operation_id, so an observation
-- labelled tenant B could point at tenant A's operation and confirm it; outbox_jobs had the same split. The
-- transition trigger also compared with `<>`, so an observation with operation_id NULL slipped through (NULL is
-- not true). From here on evidence is bound to its operation and tenant by composite keys, and the trigger checks
-- operation, tenant and classification with NULL-safe comparisons. Each statement validates existing rows: an
-- upgrade over rows that break these rules fails and rolls back instead of accepting them.

-- An observation that names an operation names that operation's tenant.
alter table provider_observations add constraint provider_observations_tenant_operation_fkey
  foreign key (tenant_id, operation_id) references refund_operations (tenant_id, id);

-- The confirmed / terminal evidence of an operation is an observation of that same operation and tenant.
alter table provider_observations add constraint provider_observations_operation_tenant_id_key
  unique (operation_id, tenant_id, id);
alter table refund_operations add constraint refund_operations_confirmed_observation_bound_fkey
  foreign key (id, tenant_id, confirmed_observation_id) references provider_observations (operation_id, tenant_id, id);
alter table refund_operations add constraint refund_operations_terminal_observation_bound_fkey
  foreign key (id, tenant_id, terminal_observation_id) references provider_observations (operation_id, tenant_id, id);

-- An operation job always carries its operation's tenant (a NULL tenant would skip the composite key).
alter table outbox_jobs add constraint outbox_jobs_operation_needs_tenant
  check (operation_id is null or tenant_id is not null);
alter table outbox_jobs add constraint outbox_jobs_tenant_operation_fkey
  foreign key (tenant_id, operation_id) references refund_operations (tenant_id, id);

create or replace function refundproof_operation_guard() returns trigger language plpgsql as $$
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
  -- Evidence references are written only by the transition they justify, and never change afterwards.
  if new.confirmed_observation_id is distinct from old.confirmed_observation_id
     and not (old.confirmed_observation_id is null and new.state = 'CONFIRMED' and old.state <> 'CONFIRMED') then
    raise exception 'refundproof: confirmed evidence is set only by the transition to CONFIRMED and is immutable'
      using errcode = '55000';
  end if;
  if new.terminal_observation_id is distinct from old.terminal_observation_id
     and not (old.terminal_observation_id is null and new.state = 'PROVIDER_TERMINAL_NOT_APPLIED'
              and old.state <> 'PROVIDER_TERMINAL_NOT_APPLIED') then
    raise exception 'refundproof: terminal evidence is set only by the transition to PROVIDER_TERMINAL_NOT_APPLIED and is immutable'
      using errcode = '55000';
  end if;
  if new.state is distinct from old.state then
    select true, evidence into rule_found, rule_evidence from operation_transition_rules
      where from_state = old.state and to_state = new.state;
    if rule_found is null then
      raise exception 'refundproof: invalid operation transition % -> %', old.state, new.state using errcode = '23514';
    end if;
    if rule_evidence = 'PROVIDER_CONFIRMED_OBSERVATION' then
      select * into obs from provider_observations where id = new.confirmed_observation_id;
      if obs.id is null or obs.operation_id is distinct from new.id or obs.tenant_id is distinct from new.tenant_id
         or obs.classification is distinct from 'REFUND_COMPLETED' then
        raise exception 'refundproof: CONFIRMED requires a REFUND_COMPLETED observation of this operation and tenant'
          using errcode = '23514';
      end if;
    elsif rule_evidence = 'PROVIDER_TERMINAL_OBSERVATION' then
      select * into obs from provider_observations where id = new.terminal_observation_id;
      if obs.id is null or obs.operation_id is distinct from new.id or obs.tenant_id is distinct from new.tenant_id
         or obs.classification is null
         or obs.classification not in ('REFUND_TERMINAL_NOT_APPLIED', 'REQUEST_REJECTED_TERMINAL') then
        raise exception 'refundproof: terminal non-application requires a terminal observation of this operation and tenant'
          using errcode = '23514';
      end if;
    elsif rule_evidence = 'PROVIDER_PENDING_OBSERVATION' then
      if not exists (select 1 from provider_observations where operation_id = new.id and tenant_id = new.tenant_id
                     and classification = 'REFUND_PENDING') then
        raise exception 'refundproof: RECONCILING from SUBMITTING requires a REFUND_PENDING observation of this operation and tenant'
          using errcode = '23514';
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
