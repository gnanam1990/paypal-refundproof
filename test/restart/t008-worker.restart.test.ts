import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../src/db/migrate';
import { enqueueJob } from '../../src/queue/outbox';
import { createTenant } from '../../src/services/tenancy';
import { PgCluster } from '../support/pg-cluster';
import { spawnTsx, waitFor } from '../support/proc';

let cluster: PgCluster;
let url: string;
let pool: pg.Pool;
let tenantId: string;

beforeAll(async () => {
  cluster = await PgCluster.start();
  const c = new pg.Client({ connectionString: cluster.url() });
  await c.connect();
  await c.query('create database t008');
  await c.end();
  url = cluster.url('t008');
  await migrateUp(url);
  pool = new pg.Pool({ connectionString: url });
  pool.on('error', () => undefined);
  tenantId = (await createTenant(pool, 'Restart merchant')).id;
});
afterAll(async () => {
  await pool.end().catch(() => undefined);
  await cluster.destroy();
});

const workerEnv = (id: string) => ({
  DATABASE_URL: url,
  WORKER_ID: id,
  WORKER_LEASE_MS: '1500',
  WORKER_POLL_MS: '100',
});
const job = async (id: number) => (await pool.query('select * from outbox_jobs where id = $1', [id])).rows[0];
const doneCount = async (id: number) =>
  (
    await pool.query(
      `select count(*)::int n from audit_events where event_type = 'SELFTEST_DONE' and subject_id = $1`,
      [String(id)],
    )
  ).rows[0].n;

describe('T-008 (durable queue) — accepted work resumes after process termination without manual repair', () => {
  it('a SIGKILLed worker’s job is reclaimed and finished by a new worker process', async () => {
    const j = await enqueueJob(pool, { kind: 'SELFTEST', tenantId, payload: { sleepMs: 4000 } });
    const a = spawnTsx('src/worker/main.ts', [], workerEnv('worker-A'));
    await waitFor(async () => (await job(j.id)).lease_owner === 'worker-A', 20_000, 'worker-A to claim');
    a.kill('SIGKILL');
    await new Promise((r) => a.on('exit', r));
    expect((await job(j.id)).state).toBe('RUNNING'); // abandoned mid-job, nothing repaired by hand

    const b = spawnTsx('src/worker/main.ts', [], workerEnv('worker-B'));
    try {
      const done = await waitFor(
        async () => ((await job(j.id)).state === 'DONE' ? job(j.id) : undefined),
        30_000,
        'job DONE',
      );
      expect(done.lease_owner).toBe('worker-B');
      expect(done.attempts).toBe(2);
      expect(await doneCount(j.id)).toBe(1);
    } finally {
      b.kill('SIGTERM');
      await new Promise((r) => b.on('exit', r));
    }
  });

  it('a live worker renews its lease, so a second worker never runs the same job concurrently', async () => {
    const j = await enqueueJob(pool, { kind: 'SELFTEST', tenantId, payload: { sleepMs: 4500 } });
    const a = spawnTsx('src/worker/main.ts', [], workerEnv('worker-C'));
    const b = spawnTsx('src/worker/main.ts', [], workerEnv('worker-D'));
    try {
      const done = await waitFor(
        async () => ((await job(j.id)).state === 'DONE' ? job(j.id) : undefined),
        30_000,
        'job DONE',
      );
      expect(done.attempts).toBe(1);
      expect(await doneCount(j.id)).toBe(1);
    } finally {
      for (const p of [a, b]) p.kill('SIGTERM');
      await Promise.all([a, b].map((p) => new Promise((r) => p.on('exit', r))));
    }
  });

  it('a worker survives a database crash-restart and completes queued work', async () => {
    const w = spawnTsx('src/worker/main.ts', [], workerEnv('worker-E'));
    try {
      await waitFor(
        async () =>
          (await pool.query(`select 1 from worker_heartbeats where worker_id = 'worker-E'`)).rowCount,
        20_000,
        'heartbeat',
      );
      await cluster.restart('immediate');
      const j = await waitFor(
        () => enqueueJob(pool, { kind: 'SELFTEST', tenantId, payload: { sleepMs: 10 } }),
        30_000,
        'db back',
      );
      await waitFor(async () => (await job(j.id)).state === 'DONE', 30_000, 'post-restart job DONE');
      expect(w.exitCode).toBeNull(); // still the same process
    } finally {
      w.kill('SIGTERM');
      await new Promise((r) => w.on('exit', r));
    }
    expect(w.output()).not.toMatch(/password|secret/i);
  });
});
