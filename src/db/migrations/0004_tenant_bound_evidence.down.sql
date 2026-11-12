-- Rollback of 0004 tenant-bound evidence: drops the composite bindings and restores the 0001 operation guard.
-- Data is kept.
alter table outbox_jobs drop constraint if exists outbox_jobs_tenant_operation_fkey;
alter table outbox_jobs drop constraint if exists outbox_jobs_operation_needs_tenant;
alter table refund_operations drop constraint if exists refund_operations_terminal_observation_bound_fkey;
alter table refund_operations drop constraint if exists refund_operations_confirmed_observation_bound_fkey;
alter table provider_observations drop constraint if exists provider_observations_operation_tenant_id_key;
alter table provider_observations drop constraint if exists provider_observations_tenant_operation_fkey;

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
