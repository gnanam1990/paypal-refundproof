-- Rollback of 0002 attempt finality: restores the 0001 attempt guard. Data is kept; the NOT_SENT finish-time
-- backfill stays (it is the honest value either way).
drop trigger if exists provider_attempts_insert_guard on provider_attempts;
drop function if exists refundproof_attempt_insert_guard();
alter table provider_attempts drop constraint if exists provider_attempts_coherent_outcome;

create or replace function refundproof_attempt_guard() returns trigger language plpgsql as $$
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
