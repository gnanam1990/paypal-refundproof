// Upgrade rehearsal for the M01 corrective migrations (0002 attempt finality, 0003 lease fencing,
// 0004 tenant-bound evidence): a database created at 0001 with representative rows, as the 0001 code wrote them,
// upgrades cleanly and keeps its data; a database holding rows that violate the new invariants refuses to
// upgrade instead of silently accepting them; and the corrective migrations roll back and re-apply with data.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadMigrations, migrateDown, migrateUp } from '../../src/db/migrate';
import { claimJobs, completeJob, LeaseLostError } from '../../src/queue/outbox';
import { seedWorld } from '../support/fixtures';
import { insertAttempt, insertObservation, makeOperation, setOperationState } from '../support/operations';

const created: string[] = [];
async function emptyDatabase() {
  const name = `up_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  created.push(name);
  const url = inject('pgAdminUrl').replace(/\/[^/]+$/, `/${name}`);
  return { url, pool: new pg.Pool({ connectionString: url, max: 6 }) };
}
afterAll(async () => {
  const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await admin.connect();
  for (const n of created) await admin.query(`drop database if exists ${n} with (force)`);
  await admin.end();
});

const ALL = loadMigrations();
const CORE = ALL.filter((m) => m.version === '0001');
const names = (ms = ALL) => ms.map((m) => `${m.version}_${m.name}`);

/** Representative 0001-era data, written the way the 0001 code wrote it. */
async function seedLegacy(pool: pg.Pool) {
  const w = await seedWorld(pool);
  const a = await makeOperation(pool, w.operator, w.approver);
  await setOperationState(pool, a.operationId, 'SUBMITTING');
  const dispatching = await insertAttempt(pool, a, 'DISPATCHING');
  const confirmed = await makeOperation(pool, w.operator, w.approver);
  await setOperationState(pool, confirmed.operationId, 'SUBMITTING');
  const responded = await insertAttempt(pool, confirmed, 'DISPATCHING');
  await pool.query(
    `update provider_attempts set phase = 'RESPONDED', finished_at = now(), http_status = 201 where id = $1`,
    [responded],
  );
  const obs = await insertObservation(pool, {
    tenantId: confirmed.tenantId,
    operationId: confirmed.operationId,
    classification: 'REFUND_COMPLETED',
  });
  await setOperationState(pool, confirmed.operationId, 'CONFIRMED', { confirmed_observation_id: obs });
  // 0001's ledger wrote NOT_SENT attempts without a finish time.
  const back = await makeOperation(pool, w.operator, w.approver);
  await setOperationState(pool, back.operationId, 'SUBMITTING');
  const notSent = await insertAttempt(pool, back, 'NOT_SENT');
  await pool.query(
    `insert into outbox_jobs (tenant_id, kind, operation_id, state, lease_owner, lease_expires_at, attempts)
     values ($1, 'DISPATCH_REFUND', $2, 'RUNNING', 'legacy-worker', now() - interval '1 minute', 1)`,
    [a.tenantId, a.operationId],
  );
  await pool.query(
    `insert into outbox_jobs (tenant_id, kind, payload) values (null, 'SELFTEST', '{"tag":"legacy"}')`,
  );
  await pool.query(
    `insert into outbox_jobs (tenant_id, kind, operation_id, state) values ($1, 'RECONCILE_REFUND', $2, 'DONE')`,
    [confirmed.tenantId, confirmed.operationId],
  );
  return { w, a, confirmed, dispatching, responded, notSent, obs };
}

const counts = async (pool: pg.Pool) =>
  (
    await pool.query(
      `select (select count(*) from refund_operations)::int ops, (select count(*) from provider_attempts)::int attempts,
              (select count(*) from provider_observations)::int obs, (select count(*) from outbox_jobs)::int jobs,
              (select count(*) from state_transitions)::int transitions, (select count(*) from audit_events)::int audits`,
    )
  ).rows[0];

describe('corrective migrations — upgrade of a populated 0001 database', () => {
  it('applies 0002..0004 to representative data, keeps it, and enforces the new rules on old rows', async () => {
    const { url, pool } = await emptyDatabase();
    try {
      expect(await migrateUp(url, CORE)).toEqual(names(CORE));
      const s = await seedLegacy(pool);
      const before = await counts(pool);

      expect(await migrateUp(url)).toEqual(names(ALL.filter((m) => m.version !== '0001')));
      expect(await counts(pool)).toEqual(before);

      // legacy NOT_SENT got a finish time (deterministic backfill) and is now frozen
      const ns = (await pool.query('select * from provider_attempts where id = $1', [s.notSent])).rows[0];
      expect(ns.finished_at).toEqual(ns.started_at);
      await expect(
        pool.query(`update provider_attempts set error_class = 'x' where id = $1`, [s.notSent]),
      ).rejects.toMatchObject({ code: '55000' });
      // the legacy DISPATCHING attempt can no longer be laundered into NOT_SENT
      await expect(
        pool.query(`update provider_attempts set phase = 'NOT_SENT', finished_at = now() where id = $1`, [
          s.dispatching,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
      // confirmed history intact and still bound
      const conf = (
        await pool.query('select * from refund_operations where id = $1', [s.confirmed.operationId])
      ).rows[0];
      expect(conf).toMatchObject({ state: 'CONFIRMED', confirmed_observation_id: s.obs });
      // the legacy in-flight lease expires and is reclaimed with a fence; the fence-0 legacy claim is stale
      const [job] = await claimJobs(pool, 'legacy-worker', {
        limit: 5,
        leaseMs: 60_000,
        kinds: ['DISPATCH_REFUND'],
      });
      expect(job).toMatchObject({ operationId: s.a.operationId, attempts: 2 });
      expect(job!.fence).toBeGreaterThan(0);
      await expect(completeJob(pool, { ...job!, fence: 0 }, 'legacy-worker')).rejects.toThrow(LeaseLostError);
      await completeJob(pool, job!, 'legacy-worker');
      // cross-tenant evidence is now refused for legacy operations too
      await expect(
        insertObservation(pool, {
          tenantId: s.w.otherTenantId,
          operationId: s.a.operationId,
          classification: 'REFUND_COMPLETED',
        }),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await pool.end();
    }
  });

  it('rolls the corrective migrations back and re-applies them with data present', async () => {
    const { url, pool } = await emptyDatabase();
    try {
      await migrateUp(url, CORE);
      await seedLegacy(pool);
      await migrateUp(url);
      const before = await counts(pool);
      const corrective = ALL.filter((m) => m.version !== '0001');
      expect(await migrateDown(url, corrective.length)).toEqual(names(corrective).reverse());
      expect(await counts(pool)).toEqual(before);
      expect(await migrateUp(url)).toEqual(names(corrective));
      expect(await counts(pool)).toEqual(before);
    } finally {
      await pool.end();
    }
  });
});

describe('corrective migrations — refuse to upgrade over rows that violate the new invariants', () => {
  async function upgradeFailsWith(
    violate: (pool: pg.Pool, s: Awaited<ReturnType<typeof seedLegacy>>) => Promise<void>,
    stopsAt: string,
    message: RegExp,
  ) {
    const { url, pool } = await emptyDatabase();
    try {
      await migrateUp(url, CORE);
      const s = await seedLegacy(pool);
      await violate(pool, s);
      const before = await counts(pool);
      await expect(migrateUp(url)).rejects.toThrow(message);
      const applied = (await pool.query('select version from schema_migrations order by version')).rows.map(
        (r) => r.version,
      );
      expect(applied).not.toContain(stopsAt);
      expect(applied.every((v) => v < stopsAt)).toBe(true);
      expect(await counts(pool)).toEqual(before);
    } finally {
      await pool.end();
    }
  }

  it('a LOST attempt without an error class stops 0002', async () => {
    await upgradeFailsWith(
      async (pool, s) => {
        await pool.query(`update provider_attempts set phase = 'LOST', finished_at = now() where id = $1`, [
          s.dispatching,
        ]);
      },
      '0002',
      /provider_attempts_coherent_outcome|check constraint/,
    );
  });

  it('an observation labelled with another tenant stops 0004', async () => {
    await upgradeFailsWith(
      async (pool, s) => {
        await insertObservation(pool, {
          tenantId: s.w.otherTenantId,
          operationId: s.a.operationId,
          classification: 'REFUND_PENDING',
        });
      },
      '0004',
      /provider_observations_tenant_operation_fkey|foreign key/,
    );
  });

  it('an operation job without a tenant stops 0004', async () => {
    await upgradeFailsWith(
      async (pool, s) => {
        await pool.query(
          `insert into outbox_jobs (tenant_id, kind, operation_id, state) values (null, 'RECONCILE_REFUND', $1, 'DONE')`,
          [s.a.operationId],
        );
      },
      '0004',
      /outbox_jobs_operation_needs_tenant|check constraint/,
    );
  });
});
