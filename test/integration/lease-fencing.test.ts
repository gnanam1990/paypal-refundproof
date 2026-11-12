// Blocker 2 (independent review of PR #4 @ c808bb9): outbox lease predicates matched job id + owner + RUNNING
// only. A worker that reclaims with the same configured owner string made a stale claim indistinguishable from
// the live one, and an expired lease could still be acted on. Invariant under test: every lease operation and
// lease-bound effect write matches job id + owner + a per-claim fence token and requires an unexpired lease.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/observability/log';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  LeaseLostError,
  renewLease,
  rescheduleJob,
  type Job,
} from '../../src/queue/outbox';
import { selftestHandler } from '../../src/worker/selftest';
import { freshDatabase } from '../support/db';
import { seedWorld, type World } from '../support/fixtures';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let w: World;
beforeAll(async () => {
  db = await freshDatabase();
  w = await seedWorld(db.pool);
});
afterAll(() => db.drop());

const OWNER = 'stable-worker-name';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tagSeq = 0;

async function claimOne(owner: string, leaseMs: number, tag: string): Promise<Job> {
  const jobs = await claimJobs(db.pool, owner, { limit: 50, leaseMs, kinds: ['SELFTEST'] });
  const mine = jobs.filter((j) => j.payload.tag === tag);
  // Give back anything we did not mean to take (other tests' jobs) so claims stay independent.
  for (const j of jobs) if (j.payload.tag !== tag) await failJob(db.pool, j, owner, 'not mine', 0);
  expect(mine).toHaveLength(1);
  return mine[0]!;
}

async function enqueue(extra: Record<string, unknown> = {}) {
  const tag = `fence-${++tagSeq}`;
  const job = await enqueueJob(db.pool, {
    kind: 'SELFTEST',
    tenantId: w.tenantId,
    payload: { tag, ...extra },
  });
  return { tag, job };
}

/** Claim with a short lease, let it expire, and reclaim with the same owner string. */
async function staleAndLive() {
  const { tag } = await enqueue();
  const stale = await claimOne(OWNER, 50, tag);
  await sleep(120);
  const live = await claimOne(OWNER, 60_000, tag);
  expect(live.id).toBe(stale.id);
  return { stale, live };
}

const row = async (id: number) =>
  (await db.pool.query('select * from outbox_jobs where id = $1', [id])).rows[0];

describe('Blocker 2 — reproduction: a same-owner stale claim is fenced', () => {
  it('stale completeJob after a same-owner reclaim throws LeaseLostError', async () => {
    const { stale, live } = await staleAndLive();
    await expect(completeJob(db.pool, stale, OWNER)).rejects.toThrow(LeaseLostError);
    expect(await row(live.id)).toMatchObject({ state: 'RUNNING' });
    await completeJob(db.pool, live, OWNER);
    expect(await row(live.id)).toMatchObject({ state: 'DONE' });
  });

  it('every claim carries a strictly larger fence token', async () => {
    const { stale, live } = await staleAndLive();
    expect(typeof stale.fence).toBe('number');
    expect(live.fence).toBeGreaterThan(stale.fence);
  });
});

describe('Blocker 2 — stale renew / fail / reschedule after a same-owner reclaim', () => {
  it('renewLease reports the lease as lost and does not extend the live lease', async () => {
    const { stale, live } = await staleAndLive();
    const before = (await row(live.id)).lease_expires_at;
    expect(await renewLease(db.pool, stale, OWNER, 1)).toBe(false);
    expect((await row(live.id)).lease_expires_at).toEqual(before);
    await completeJob(db.pool, live, OWNER);
  });

  it('failJob throws and leaves the live claim running', async () => {
    const { stale, live } = await staleAndLive();
    await expect(failJob(db.pool, stale, OWNER, new Error('stale'), 0)).rejects.toThrow(LeaseLostError);
    expect(await row(live.id)).toMatchObject({ state: 'RUNNING', last_error: null });
    await completeJob(db.pool, live, OWNER);
  });

  it('rescheduleJob throws and leaves the live claim running', async () => {
    const { stale, live } = await staleAndLive();
    await expect(rescheduleJob(db.pool, stale, OWNER, new Date(Date.now() + 60_000))).rejects.toThrow(
      LeaseLostError,
    );
    expect(await row(live.id)).toMatchObject({ state: 'RUNNING' });
    await completeJob(db.pool, live, OWNER);
  });
});

describe('Blocker 2 — an expired lease cannot be acted on even before anyone reclaims it', () => {
  it('complete, renew, fail and reschedule all refuse an expired lease', async () => {
    const { tag } = await enqueue();
    const j = await claimOne(OWNER, 50, tag);
    await sleep(120);
    await expect(completeJob(db.pool, j, OWNER)).rejects.toThrow(LeaseLostError);
    expect(await renewLease(db.pool, j, OWNER, 60_000)).toBe(false);
    await expect(failJob(db.pool, j, OWNER, new Error('late'), 0)).rejects.toThrow(LeaseLostError);
    await expect(rescheduleJob(db.pool, j, OWNER, new Date())).rejects.toThrow(LeaseLostError);
    expect(await row(j.id)).toMatchObject({ state: 'RUNNING' });
    const again = await claimOne(OWNER, 60_000, tag);
    expect(again.fence).toBeGreaterThan(j.fence);
    await completeJob(db.pool, again, OWNER);
  });

  it('a lease renewed in time stays usable (positive control)', async () => {
    const { tag } = await enqueue();
    const j = await claimOne(OWNER, 300, tag);
    for (let i = 0; i < 4; i++) {
      await sleep(100);
      expect(await renewLease(db.pool, j, OWNER, 300)).toBe(true);
    }
    await completeJob(db.pool, j, OWNER);
  });
});

describe('Blocker 2 — lease-bound effects', () => {
  const ctxFor = (signal = new AbortController().signal) => ({
    pool: db.pool,
    workerId: OWNER,
    log: createLogger({}, () => undefined),
    signal,
  });
  const effects = async (jobId: number) =>
    (
      await db.pool.query(
        `select count(*)::int n from audit_events where event_type = 'SELFTEST_DONE' and subject_id = $1`,
        [String(jobId)],
      )
    ).rows[0].n;

  it('stale and live handlers racing on one job produce exactly one effect', async () => {
    for (let round = 0; round < 5; round++) {
      const { stale, live } = await staleAndLive();
      const [a, b] = await Promise.allSettled([
        selftestHandler(stale, ctxFor()),
        selftestHandler(live, ctxFor()),
      ]);
      expect(a.status).toBe('rejected');
      expect((a as PromiseRejectedResult).reason).toBeInstanceOf(LeaseLostError);
      expect(b).toMatchObject({ status: 'fulfilled', value: 'COMPLETED_IN_TX' });
      expect(await effects(live.id)).toBe(1);
      expect(await row(live.id)).toMatchObject({ state: 'DONE' });
    }
  });

  it('a stale handler alone (after reclaim, before the live one runs) produces no effect', async () => {
    const { stale, live } = await staleAndLive();
    await expect(selftestHandler(stale, ctxFor())).rejects.toThrow(LeaseLostError);
    expect(await effects(live.id)).toBe(0);
    await selftestHandler(live, ctxFor());
    expect(await effects(live.id)).toBe(1);
  });

  it('concurrent effect attempts on separate connections by the live claim are applied once', async () => {
    const { tag } = await enqueue();
    const live = await claimOne(OWNER, 60_000, tag);
    const pools = Array.from({ length: 4 }, () => new pg.Pool({ connectionString: db.url, max: 2 }));
    try {
      const results = await Promise.allSettled(
        pools.map((p) => selftestHandler(live, { ...ctxFor(), pool: p })),
      );
      // Duplicate runs by the live claim are acknowledged without a second effect, or lose the race cleanly.
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LeaseLostError);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expect(await effects(live.id)).toBe(1);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });
});

describe('Blocker 2 — response loss and retry', () => {
  it('a retried completeJob by the same claim is acknowledged; a later failJob is refused', async () => {
    const { tag } = await enqueue();
    const j = await claimOne(OWNER, 60_000, tag);
    await completeJob(db.pool, j, OWNER); // committed, but suppose the response was lost
    await expect(completeJob(db.pool, j, OWNER)).resolves.toBe('ALREADY_COMPLETED');
    await expect(failJob(db.pool, j, OWNER, new Error('after done'), 0)).rejects.toThrow(LeaseLostError);
    expect(await row(j.id)).toMatchObject({ state: 'DONE', last_error: null });
  });

  it('a retried failJob by the same claim is acknowledged without a second effect', async () => {
    const { tag } = await enqueue();
    const j = await claimOne(OWNER, 60_000, tag);
    await failJob(db.pool, j, OWNER, new Error('first'), 60_000);
    const after = await row(j.id);
    await expect(failJob(db.pool, j, OWNER, new Error('retry'), 0)).resolves.toBeUndefined();
    expect(await row(j.id)).toEqual(after);
  });

  it('a retried rescheduleJob by the same claim is acknowledged without a second effect', async () => {
    const { tag } = await enqueue();
    const j = await claimOne(OWNER, 60_000, tag);
    const at = new Date(Date.now() + 60_000);
    await rescheduleJob(db.pool, j, OWNER, at);
    const after = await row(j.id);
    await expect(rescheduleJob(db.pool, j, OWNER, at)).resolves.toBeUndefined();
    expect(await row(j.id)).toEqual(after);
  });

  it('a retry after another claim took over is refused', async () => {
    const { tag } = await enqueue();
    const j = await claimOne(OWNER, 60_000, tag);
    await failJob(db.pool, j, OWNER, new Error('first'), 0);
    const next = await claimOne(OWNER, 60_000, tag);
    await expect(failJob(db.pool, j, OWNER, new Error('retry'), 0)).rejects.toThrow(LeaseLostError);
    await expect(completeJob(db.pool, j, OWNER)).rejects.toThrow(LeaseLostError);
    // The newer claim closes the job the same way; the older claim's retry must still not be acknowledged.
    await failJob(db.pool, next, OWNER, new Error('second'), 0);
    await expect(failJob(db.pool, j, OWNER, new Error('retry'), 0)).rejects.toThrow(LeaseLostError);
    const third = await claimOne(OWNER, 60_000, tag);
    await completeJob(db.pool, third, OWNER);
    await expect(completeJob(db.pool, next, OWNER)).rejects.toThrow(LeaseLostError);
    expect(await completeJob(db.pool, third, OWNER)).toBe('ALREADY_COMPLETED');
  });

  it('the fence token can never move backwards in the database', async () => {
    const { tag } = await enqueue();
    const j = await claimOne(OWNER, 60_000, tag);
    await expect(
      db.pool.query('update outbox_jobs set lease_token = lease_token - 1 where id = $1', [j.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await completeJob(db.pool, j, OWNER);
  });
});
