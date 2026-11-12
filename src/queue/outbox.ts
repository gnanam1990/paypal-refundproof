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
  /** Fence token of the claim that produced this Job value; strictly larger for every new claim of the job. */
  fence: number;
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
  fence: Number(r.lease_token ?? 0),
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
 * sets. Expired jobs that already used every attempt are dead-lettered instead of re-run. Every claim bumps the
 * job's fence token, so a claim is identified by (id, fence) and not by the owner string alone. Lease times use
 * the database clock (clock_timestamp()), never a worker's.
 */
export async function claimJobs(
  db: Queryable,
  workerId: string,
  o: { limit: number; leaseMs: number; kinds: JobKind[] },
): Promise<Job[]> {
  await db.query(
    `update outbox_jobs set state = 'DEAD', last_error = coalesce(last_error, 'lease expired after final attempt'), updated_at = now()
      where state = 'RUNNING' and lease_expires_at < clock_timestamp() and attempts >= max_attempts`,
  );
  const r = await db.query(
    `with c as (
       select id from outbox_jobs
        where kind = any($3::text[])
          and ((state = 'PENDING' and run_at <= now())
               or (state = 'RUNNING' and lease_expires_at < clock_timestamp() and attempts < max_attempts))
        order by run_at, id
        limit $2
        for update skip locked)
     update outbox_jobs j
        set state = 'RUNNING', lease_owner = $1,
            lease_expires_at = clock_timestamp() + make_interval(secs => $4::double precision / 1000),
            lease_token = j.lease_token + 1, closed_token = null, closed_action = null,
            attempts = j.attempts + 1, updated_at = now()
       from c where j.id = c.id
     returning j.*`,
    [workerId, o.limit, o.kinds, o.leaseMs],
  );
  return r.rows.map(toJob).sort((a, b) => a.id - b.id);
}

/**
 * The lease is held by exactly this claim: same job, owner and fence, still RUNNING, not yet expired. Every lease
 * operation below uses it, and a handler that writes an effect must do so in the same transaction as a fenced
 * call (completeJob / failJob / rescheduleJob), which locks the job row first (see src/worker/selftest.ts).
 */
const HELD = `id = $1 and lease_owner = $2 and lease_token = $3 and state = 'RUNNING' and lease_expires_at > clock_timestamp()`;

type CloseAction = 'COMPLETE' | 'FAIL' | 'RESCHEDULE';

/** After a fenced close matched no row: was it already applied by this same claim (a retry after a lost response)? */
async function closedByThisClaim(db: Queryable, job: Job, action: CloseAction): Promise<boolean> {
  const r = await db.query(
    `select 1 from outbox_jobs where id = $1 and lease_token = $2 and closed_token = $2 and closed_action = $3`,
    [job.id, job.fence, action],
  );
  return r.rowCount === 1;
}

const lost = (job: Job, workerId: string) =>
  new LeaseLostError(`lease on job ${job.id} (fence ${job.fence}) is no longer held by ${workerId}`);

/**
 * Locks the job row and proves this exact claim still holds an unexpired lease. Call it first inside any
 * transaction that writes an effect for the job, so a stale or reclaimed worker cannot write one.
 */
export async function holdLease(db: Queryable, job: Job, workerId: string): Promise<void> {
  const r = await db.query(`select 1 from outbox_jobs where ${HELD} for update`, [
    job.id,
    workerId,
    job.fence,
  ]);
  if (r.rowCount !== 1) throw lost(job, workerId);
}

/** Extends the lease. False when this claim no longer holds it (expired, reclaimed, or closed). */
export async function renewLease(
  db: Queryable,
  job: Job,
  workerId: string,
  leaseMs: number,
): Promise<boolean> {
  const r = await db.query(
    `update outbox_jobs set lease_expires_at = clock_timestamp() + make_interval(secs => $4::double precision / 1000), updated_at = now()
      where ${HELD}`,
    [job.id, workerId, job.fence, leaseMs],
  );
  return r.rowCount === 1;
}

/**
 * Marks the job DONE. 'ALREADY_COMPLETED' means this same claim completed it before (the earlier response was
 * lost); callers must not repeat the effect. Throws LeaseLostError when the lease is not held by this claim.
 */
export async function completeJob(
  db: Queryable,
  job: Job,
  workerId: string,
): Promise<'COMPLETED' | 'ALREADY_COMPLETED'> {
  const r = await db.query(
    `update outbox_jobs set state = 'DONE', lease_expires_at = null, closed_token = lease_token,
            closed_action = 'COMPLETE', updated_at = now()
      where ${HELD}`,
    [job.id, workerId, job.fence],
  );
  if (r.rowCount === 1) return 'COMPLETED';
  if (await closedByThisClaim(db, job, 'COMPLETE')) return 'ALREADY_COMPLETED';
  throw lost(job, workerId);
}

export async function failJob(db: Queryable, job: Job, workerId: string, err: unknown, retryDelayMs: number) {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const r = await db.query(
    `update outbox_jobs
        set state = case when attempts >= max_attempts then 'DEAD' else 'PENDING' end,
            run_at = now() + make_interval(secs => $5::double precision / 1000),
            lease_owner = case when attempts >= max_attempts then lease_owner else null end,
            lease_expires_at = null, last_error = $4, closed_token = lease_token, closed_action = 'FAIL',
            updated_at = now()
      where ${HELD}`,
    [job.id, workerId, job.fence, message, Math.max(0, retryDelayMs)],
  );
  if (r.rowCount === 1 || (await closedByThisClaim(db, job, 'FAIL'))) return;
  throw lost(job, workerId);
}

/** Re-schedule an operation job at a future time (used by reconciliation backoff). */
export async function rescheduleJob(db: Queryable, job: Job, workerId: string, runAt: Date) {
  const r = await db.query(
    `update outbox_jobs set state = 'PENDING', run_at = $4, lease_owner = null, lease_expires_at = null, attempts = 0,
            closed_token = lease_token, closed_action = 'RESCHEDULE', updated_at = now()
      where ${HELD}`,
    [job.id, workerId, job.fence, runAt],
  );
  if (r.rowCount === 1 || (await closedByThisClaim(db, job, 'RESCHEDULE'))) return;
  throw lost(job, workerId);
}
