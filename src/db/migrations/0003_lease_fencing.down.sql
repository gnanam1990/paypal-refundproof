-- Rollback of 0003 lease fencing. Jobs are kept; fence tokens and closing claims are dropped.
drop trigger if exists outbox_jobs_fence_guard on outbox_jobs;
drop function if exists refundproof_outbox_fence_guard();
alter table outbox_jobs
  drop constraint if exists outbox_jobs_closed_by_current_claim,
  drop column if exists closed_action,
  drop column if exists closed_token,
  drop column if exists lease_token;
