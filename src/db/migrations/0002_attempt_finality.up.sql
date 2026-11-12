-- 0002 attempt finality (M01 corrective, Blocker 1).
-- 0001 froze an attempt's phase only after it had left DISPATCHING, so a DISPATCHING attempt could be rewritten
-- as NOT_SENT, which then let SUBMITTING -> READY succeed and a second dispatch begin. Rules from here on:
--   * attempts are born DISPATCHING, or NOT_SENT only while no attempt of the operation has begun dispatch;
--   * DISPATCHING changes only by reaching an honest terminal outcome, RESPONDED or LOST, never NOT_SENT;
--   * RESPONDED, LOST and NOT_SENT rows are frozen, and every phase carries a coherent evidence tuple;
--   * what was sent (request_meta) never changes.

-- 0001's ledger recorded NOT_SENT without a finish time. NOT_SENT is final from birth, so the only honest finish
-- time is its start time. No other legacy row is rewritten: incoherent rows make this migration fail instead.
update provider_attempts set finished_at = started_at where phase = 'NOT_SENT' and finished_at is null;

alter table provider_attempts add constraint provider_attempts_coherent_outcome check (coalesce(
  (finished_at is null or finished_at >= started_at) and case phase
    when 'DISPATCHING' then finished_at is null and http_status is null and error_class is null
                            and response_meta = '{}'::jsonb
    when 'RESPONDED' then finished_at is not null and http_status between 100 and 599
    when 'LOST' then finished_at is not null and http_status is null and error_class is not null
    when 'NOT_SENT' then finished_at is not null and http_status is null and response_meta = '{}'::jsonb
  end, false));

create function refundproof_attempt_insert_guard() returns trigger language plpgsql as $$
begin
  -- Serialize attempt creation per operation, and against SUBMITTING -> READY (which locks the same row).
  perform 1 from refund_operations where id = new.operation_id for update;
  if new.phase = 'NOT_SENT' then
    if exists (select 1 from provider_attempts where operation_id = new.operation_id and phase <> 'NOT_SENT') then
      raise exception 'refundproof: NOT_SENT cannot be recorded once dispatch began for this operation'
        using errcode = '23514';
    end if;
    if new.finished_at is null then
      new.finished_at := greatest(new.started_at, clock_timestamp());
    end if;
  elsif new.phase <> 'DISPATCHING' then
    raise exception 'refundproof: attempts are created DISPATCHING; % is reached only from DISPATCHING', new.phase
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger provider_attempts_insert_guard before insert on provider_attempts
  for each row execute function refundproof_attempt_insert_guard();

create or replace function refundproof_attempt_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'refundproof: provider attempts are never deleted' using errcode = '55000';
  end if;
  if (new.id, new.operation_id, new.paypal_request_id, new.attempt_no, new.started_at, new.correlation_id,
      new.request_meta)
     is distinct from
     (old.id, old.operation_id, old.paypal_request_id, old.attempt_no, old.started_at, old.correlation_id,
      old.request_meta) then
    raise exception 'refundproof: attempt identity and the request it sent are immutable' using errcode = '55000';
  end if;
  if old.phase <> 'DISPATCHING' then
    if new is distinct from old then
      raise exception 'refundproof: attempt phase % is final; its evidence cannot change', old.phase
        using errcode = '55000';
    end if;
  elsif new.phase = 'NOT_SENT' then
    raise exception 'refundproof: an attempt that began dispatch can never become NOT_SENT' using errcode = '55000';
  elsif new.phase = 'DISPATCHING' and new is distinct from old then
    raise exception 'refundproof: a DISPATCHING attempt changes only by reaching RESPONDED or LOST'
      using errcode = '55000';
  end if;
  return new;
end $$;
