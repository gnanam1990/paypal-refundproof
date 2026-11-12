import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../../src/db/pool';
import { claimJobs, completeJob, enqueueJob, failJob } from '../../src/queue/outbox';
import { freshDatabase } from '../support/db';
import { seedWorld, type World } from '../support/fixtures';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let w: World;
beforeAll(async () => {
  db = await freshDatabase();
  w = await seedWorld(db.pool);
});
afterAll(() => db.drop());

describe('transactional outbox', () => {
  it('enqueues only when the surrounding transaction commits', async () => {
    await expect(
      withTx(db.pool, async (c) => {
        await enqueueJob(c, { kind: 'SELFTEST', tenantId: w.tenantId, payload: { tag: 'rolled-back' } });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const n = await db.pool.query(
      `select count(*)::int n from outbox_jobs where payload->>'tag' = 'rolled-back'`,
    );
    expect(n.rows[0].n).toBe(0);
  });

  it('hands each job to exactly one concurrent claimer', async () => {
    for (let i = 0; i < 20; i++)
      await enqueueJob(db.pool, { kind: 'SELFTEST', tenantId: w.tenantId, payload: { tag: 'claim', i } });
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, k) =>
        claimJobs(db.pool, `worker-${k}`, { limit: 10, leaseMs: 60_000, kinds: ['SELFTEST'] }),
      ),
    );
    const ids = claims.flat().map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(20);
    for (const [k, jobs] of claims.entries())
      for (const j of jobs) await completeJob(db.pool, j, `worker-${k}`);
  });

  it('reclaims a job whose lease expired and rejects completion by the stale owner', async () => {
    await enqueueJob(db.pool, { kind: 'SELFTEST', tenantId: w.tenantId, payload: { tag: 'lease' } });
    const [first] = await claimJobs(db.pool, 'dead-worker', { limit: 1, leaseMs: 50, kinds: ['SELFTEST'] });
    expect(first).toBeDefined();
    await new Promise((r) => setTimeout(r, 120));
    const [again] = await claimJobs(db.pool, 'live-worker', {
      limit: 1,
      leaseMs: 60_000,
      kinds: ['SELFTEST'],
    });
    expect(again?.id).toBe(first!.id);
    expect(again?.attempts).toBe(2);
    await expect(completeJob(db.pool, first!, 'dead-worker')).rejects.toThrow(/lease/);
    await completeJob(db.pool, again!, 'live-worker');
    const s = await db.pool.query('select state from outbox_jobs where id = $1', [first!.id]);
    expect(s.rows[0].state).toBe('DONE');
  });

  it('backs off failed jobs and dead-letters at the attempt bound', async () => {
    const job = await enqueueJob(db.pool, {
      kind: 'SELFTEST',
      tenantId: w.tenantId,
      payload: { tag: 'fail' },
      maxAttempts: 2,
    });
    let [j] = await claimJobs(db.pool, 'w', { limit: 1, leaseMs: 60_000, kinds: ['SELFTEST'] });
    expect(j!.id).toBe(job.id);
    await failJob(db.pool, j!, 'w', new Error('boom'), 0);
    [j] = await claimJobs(db.pool, 'w', { limit: 1, leaseMs: 60_000, kinds: ['SELFTEST'] });
    await failJob(db.pool, j!, 'w', new Error('boom again'), 0);
    const s = await db.pool.query('select state, attempts, last_error from outbox_jobs where id = $1', [
      job.id,
    ]);
    expect(s.rows[0]).toMatchObject({ state: 'DEAD', attempts: 2, last_error: 'boom again' });
  });
});
