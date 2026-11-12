import type { Queryable } from '../db/pool';

export type JobKind = 'DISPATCH_REFUND' | 'RECONCILE_REFUND' | 'SELFTEST';

export interface Job {
  id: number;
  kind: JobKind;
  tenantId: string | null;
  operationId: string | null;
  payload: Record<string, unknown>;
  state: 'PENDING' | 'RUNNING' | 'DONE' | 'DEAD';
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  runAt: string;
}

const toJob = (r: Record<string, unknown>): Job => ({
  id: Number(r.id),
  kind: r.kind as JobKind,
  tenantId: (r.tenant_id as string | null) ?? null,
  operationId: (r.operation_id as string | null) ?? null,
  payload: (r.payload as Record<string, unknown>) ?? {},
  state: r.state as Job['state'],
  attempts: r.attempts as number,
  maxAttempts: r.max_attempts as number,
  leaseOwner: (r.lease_owner as string | null) ?? null,
  runAt: new Date(r.run_at as string).toISOString(),
});

export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
}

/**
 * Transactional enqueue: call with the same client as the state change it schedules, so both commit or neither
 * does. At most one active job per (kind, operation); a duplicate enqueue returns the active job.
 */
export async function enqueueJob(
  db: Queryable,
  j: {
    kind: JobKind;
    tenantId: string | null;
    operationId?: string | null;
    payload?: Record<string, unknown>;
    runAt?: Date;
    maxAttempts?: number;
  },
): Promise<Job> {
  const r = await db.query(
    `insert into outbox_jobs (tenant_id, kind, operation_id, payload, run_at, max_attempts)
     values ($1, $2, $3, $4, coalesce($5, now()), coalesce($6, 20))
     on conflict (kind, operation_id) where state in ('PENDING', 'RUNNING') and operation_id is not null do nothing
     returning *`,
    [
      j.tenantId,
      j.kind,
      j.operationId ?? null,
      JSON.stringify(j.payload ?? {}),
      j.runAt ?? null,
      j.maxAttempts ?? null,
    ],
  );
  if (r.rows[0]) return toJob(r.rows[0]);
  const existing = await db.query(
    `select * from outbox_jobs where kind = $1 and operation_id = $2 and state in ('PENDING', 'RUNNING') limit 1`,
    [j.kind, j.operationId],
  );
  return toJob(existing.rows[0]);
}

/**
 * Claims due jobs (and jobs whose lease expired) with FOR UPDATE SKIP LOCKED, so concurrent workers get disjoint
 * sets. Expired jobs that already used every attempt are dead-lettered instead of re-run.
 */
export async function claimJobs(
  db: Queryable,
  workerId: string,
  o: { limit: number; leaseMs: number; kinds: JobKind[] },
): Promise<Job[]> {
  await db.query(
    `update outbox_jobs set state = 'DEAD', last_error = coalesce(last_error, 'lease expired after final attempt'), updated_at = now()
      where state = 'RUNNING' and lease_expires_at < now() and attempts >= max_attempts`,
  );
  const r = await db.query(
    `with c as (
       select id from outbox_jobs
        where kind = any($3::text[])
          and ((state = 'PENDING' and run_at <= now()) or (state = 'RUNNING' and lease_expires_at < now() and attempts < max_attempts))
        order by run_at, id
        limit $2
        for update skip locked)
     update outbox_jobs j
        set state = 'RUNNING', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $4::double precision / 1000),
            attempts = j.attempts + 1, updated_at = now()
       from c where j.id = c.id
     returning j.*`,
    [workerId, o.limit, o.kinds, o.leaseMs],
  );
  return r.rows.map(toJob).sort((a, b) => a.id - b.id);
}

export async function renewLease(
  db: Queryable,
  job: Job,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const r = await db.query(
    `update outbox_jobs set lease_expires_at = now() + make_interval(secs => $3::double precision / 1000), updated_at = now()
      where id = $1 and lease_owner = $2 and state = 'RUNNING'`,
    [job.id, workerId, leaseMs],
  );
  return r.rowCount === 1;
}

export async function completeJob(db: Queryable, job: Job, workerId: string) {
  const r = await db.query(
    `update outbox_jobs set state = 'DONE', lease_expires_at = null, updated_at = now()
      where id = $1 and lease_owner = $2 and state = 'RUNNING'`,
    [job.id, workerId],
  );
  if (r.rowCount !== 1) throw new LeaseLostError(`lease on job ${job.id} is no longer held by ${workerId}`);
}

export async function failJob(db: Queryable, job: Job, workerId: string, err: unknown, retryDelayMs: number) {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const r = await db.query(
    `update outbox_jobs
        set state = case when attempts >= max_attempts then 'DEAD' else 'PENDING' end,
            run_at = now() + make_interval(secs => $4::double precision / 1000),
            lease_owner = case when attempts >= max_attempts then lease_owner else null end,
            lease_expires_at = null, last_error = $3, updated_at = now()
      where id = $1 and lease_owner = $2 and state = 'RUNNING'`,
    [job.id, workerId, message, Math.max(0, retryDelayMs)],
  );
  if (r.rowCount !== 1) throw new LeaseLostError(`lease on job ${job.id} is no longer held by ${workerId}`);
}

/** Re-schedule an operation job at a future time (used by reconciliation backoff). */
export async function rescheduleJob(db: Queryable, job: Job, workerId: string, runAt: Date) {
  const r = await db.query(
    `update outbox_jobs set state = 'PENDING', run_at = $3, lease_owner = null, lease_expires_at = null, attempts = 0, updated_at = now()
      where id = $1 and lease_owner = $2 and state = 'RUNNING'`,
    [job.id, workerId, runAt],
  );
  if (r.rowCount !== 1) throw new LeaseLostError(`lease on job ${job.id} is no longer held by ${workerId}`);
}
