-- 0003 lease fencing (M01 corrective, Blocker 2).
-- 0001's lease predicates matched job id + lease_owner + RUNNING. A worker that reclaimed an expired job under the
-- same configured owner string made the stale claim indistinguishable from the live one, and an expired lease
-- could still be renewed or completed. From here on every claim gets a strictly larger fence token, and every
-- renew / complete / fail / reschedule (and the effect written in the same transaction) must match
-- id + owner + fence on an unexpired lease (src/queue/outbox.ts).
--
-- closed_token / closed_action record which claim closed the job and how, so a call retried after a lost response
-- is acknowledged exactly once and only for the claim that made it.
alter table outbox_jobs
  add column lease_token bigint not null default 0 check (lease_token >= 0),
  add column closed_token bigint,
  add column closed_action text check (closed_action in ('COMPLETE', 'FAIL', 'RESCHEDULE')),
  add constraint outbox_jobs_closed_by_current_claim check (
    (closed_token is null and closed_action is null)
    or (closed_token = lease_token and closed_action is not null));

create function refundproof_outbox_fence_guard() returns trigger language plpgsql as $$
begin
  if new.lease_token < old.lease_token then
    raise exception 'refundproof: outbox fence tokens never decrease (% -> %)', old.lease_token, new.lease_token
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger outbox_jobs_fence_guard before update on outbox_jobs
  for each row execute function refundproof_outbox_fence_guard();
