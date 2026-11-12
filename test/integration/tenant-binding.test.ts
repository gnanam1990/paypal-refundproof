// Blocker 3 (independent review of PR #4 @ c808bb9): provider_observations.tenant_id and operation_id had
// independent foreign keys, so an observation labelled tenant B could point at tenant A's operation and
// confirm it. Invariant under test: observations and outbox jobs are bound to their operation's tenant in the
// schema, and an operation's confirmed/terminal/pending evidence must belong to that operation and tenant.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase } from '../support/db';
import { seedWorld, type World } from '../support/fixtures';
import {
  insertObservation,
  makeOperation,
  setOperationState,
  type TestOperation,
} from '../support/operations';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let w: World;
beforeAll(async () => {
  db = await freshDatabase();
  w = await seedWorld(db.pool);
});
afterAll(() => db.drop());

const opA = () => makeOperation(db.pool, w.operator, w.approver);
const opB = () => makeOperation(db.pool, w.outsider, w.outsiderApprover);
async function submittingA(): Promise<TestOperation> {
  const op = await opA();
  await setOperationState(db.pool, op.operationId, 'SUBMITTING');
  return op;
}
const stateOf = async (opId: string) =>
  (await db.pool.query('select state from refund_operations where id = $1', [opId])).rows[0].state as string;

type Target = { to: string; column: string | null; classification: string };
const TARGETS: Target[] = [
  { to: 'CONFIRMED', column: 'confirmed_observation_id', classification: 'REFUND_COMPLETED' },
  {
    to: 'PROVIDER_TERMINAL_NOT_APPLIED',
    column: 'terminal_observation_id',
    classification: 'REFUND_TERMINAL_NOT_APPLIED',
  },
  { to: 'RECONCILING', column: null, classification: 'REFUND_PENDING' },
];
const apply = (op: TestOperation, t: Target, obsId: string) =>
  setOperationState(db.pool, op.operationId, t.to, t.column ? { [t.column]: obsId } : {});

describe('Blocker 3 — reproduction: a tenant-B observation cannot confirm tenant A', () => {
  it('refuses an observation labelled tenant B that points at tenant A’s operation', async () => {
    const a = await submittingA();
    await expect(
      insertObservation(db.pool, {
        tenantId: w.otherTenantId,
        operationId: a.operationId,
        classification: 'REFUND_COMPLETED',
      }),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await stateOf(a.operationId)).toBe('SUBMITTING');
  });
});

describe('Blocker 3 — every cross-tenant / unbound evidence permutation', () => {
  for (const t of TARGETS) {
    it(`${t.to}: refuses tenant A evidence that is not bound to the operation (operation_id null)`, async () => {
      const a = await submittingA();
      const obs = await insertObservation(db.pool, {
        tenantId: a.tenantId,
        operationId: null,
        classification: t.classification,
      });
      await expect(apply(a, t, obs)).rejects.toMatchObject({
        code: expect.stringMatching(/^(23503|23514)$/),
      });
      expect(await stateOf(a.operationId)).toBe('SUBMITTING');
    });

    it(`${t.to}: refuses tenant B evidence for tenant B’s own operation`, async () => {
      const a = await submittingA();
      const b = await opB();
      const obs = await insertObservation(db.pool, {
        tenantId: b.tenantId,
        operationId: b.operationId,
        classification: t.classification,
      });
      await expect(apply(a, t, obs)).rejects.toMatchObject({
        code: expect.stringMatching(/^(23503|23514)$/),
      });
      expect(await stateOf(a.operationId)).toBe('SUBMITTING');
    });

    it(`${t.to}: refuses tenant A evidence for another tenant-A operation`, async () => {
      const a = await submittingA();
      const a2 = await opA();
      const obs = await insertObservation(db.pool, {
        tenantId: a.tenantId,
        operationId: a2.operationId,
        classification: t.classification,
      });
      await expect(apply(a, t, obs)).rejects.toMatchObject({
        code: expect.stringMatching(/^(23503|23514)$/),
      });
      expect(await stateOf(a.operationId)).toBe('SUBMITTING');
    });

    it(`${t.to}: accepts tenant A evidence bound to the operation (positive control)`, async () => {
      const a = await submittingA();
      const obs = await insertObservation(db.pool, {
        tenantId: a.tenantId,
        operationId: a.operationId,
        classification: t.classification,
      });
      await apply(a, t, obs);
      expect(await stateOf(a.operationId)).toBe(t.to);
    });
  }

  it('refuses an observation labelled tenant A that points at tenant B’s operation', async () => {
    const b = await opB();
    await expect(
      insertObservation(db.pool, {
        tenantId: w.tenantId,
        operationId: b.operationId,
        classification: 'REFUND_COMPLETED',
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('cannot re-point a confirmed operation at other evidence', async () => {
    const a = await submittingA();
    const obs = await insertObservation(db.pool, {
      tenantId: a.tenantId,
      operationId: a.operationId,
      classification: 'REFUND_COMPLETED',
    });
    await apply(a, TARGETS[0]!, obs);
    const other = await insertObservation(db.pool, {
      tenantId: a.tenantId,
      operationId: a.operationId,
      classification: 'REFUND_COMPLETED',
    });
    await expect(
      db.pool.query('update refund_operations set confirmed_observation_id = $2 where id = $1', [
        a.operationId,
        other,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
  });
});

describe('Blocker 3 — outbox jobs are bound to their operation’s tenant', () => {
  const enqueueRaw = (tenantId: string | null, operationId: string | null, kind = 'RECONCILE_REFUND') =>
    db.pool.query(`insert into outbox_jobs (tenant_id, kind, operation_id) values ($1, $2, $3)`, [
      tenantId,
      kind,
      operationId,
    ]);

  it('refuses a tenant-B job for tenant A’s operation', async () => {
    const a = await opA();
    await expect(enqueueRaw(w.otherTenantId, a.operationId)).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses an operation job without a tenant', async () => {
    const a = await opA();
    await expect(enqueueRaw(null, a.operationId)).rejects.toMatchObject({ code: '23514' });
  });

  it('cannot move an existing job to another tenant', async () => {
    const a = await opA();
    const r = await db.pool.query(
      `insert into outbox_jobs (tenant_id, kind, operation_id) values ($1, 'RECONCILE_REFUND', $2) returning id`,
      [a.tenantId, a.operationId],
    );
    await expect(
      db.pool.query('update outbox_jobs set tenant_id = $2 where id = $1', [r.rows[0].id, w.otherTenantId]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('allows a same-tenant operation job and a tenant-less SELFTEST job (positive control)', async () => {
    const a = await opA();
    await enqueueRaw(a.tenantId, a.operationId);
    await enqueueRaw(null, null, 'SELFTEST');
  });
});

describe('Blocker 3 — the transition trigger checks tenant on its own (defense in depth)', () => {
  const BOUND_FKS = [
    ['provider_observations', 'provider_observations_tenant_operation_fkey'],
    ['refund_operations', 'refund_operations_confirmed_observation_bound_fkey'],
    ['refund_operations', 'refund_operations_terminal_observation_bound_fkey'],
  ];

  for (const t of TARGETS)
    it(`${t.to}: refused by the trigger even with the binding foreign keys removed`, async () => {
      const a = await submittingA();
      const c = await db.pool.connect();
      try {
        await c.query('begin');
        for (const [table, name] of BOUND_FKS) await c.query(`alter table ${table} drop constraint ${name}`);
        const obs = await insertObservation(c, {
          tenantId: w.otherTenantId,
          operationId: a.operationId,
          classification: t.classification,
        });
        await expect(
          setOperationState(c, a.operationId, t.to, t.column ? { [t.column]: obs } : {}),
        ).rejects.toMatchObject({
          code: '23514',
          message: expect.stringMatching(/tenant|matching|requires/),
        });
      } finally {
        await c.query('rollback');
        c.release();
      }
      // the constraints are back after rollback
      const n = await db.pool.query(
        `select count(*)::int n from pg_constraint where conname = any($1::text[])`,
        [BOUND_FKS.map((x) => x[1])],
      );
      expect(n.rows[0].n).toBe(BOUND_FKS.length);
    });
});

describe('Blocker 3 — each layer holds on its own', () => {
  const DROP_BOUND = [
    ['provider_observations', 'provider_observations_tenant_operation_fkey'],
    ['refund_operations', 'refund_operations_confirmed_observation_bound_fkey'],
    ['refund_operations', 'refund_operations_terminal_observation_bound_fkey'],
  ];
  async function inRolledBackTx(fn: (c: import('pg').PoolClient) => Promise<void>) {
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await fn(c);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  for (const t of TARGETS.filter((x) => x.column))
    it(`${t.to}: the trigger alone refuses evidence with no operation (NULL-safe), keys dropped`, async () => {
      const a = await submittingA();
      await inRolledBackTx(async (c) => {
        for (const [table, name] of DROP_BOUND) await c.query(`alter table ${table} drop constraint ${name}`);
        const obs = await insertObservation(c, {
          tenantId: a.tenantId,
          operationId: null,
          classification: t.classification,
        });
        await expect(setOperationState(c, a.operationId, t.to, { [t.column!]: obs })).rejects.toMatchObject({
          code: '23514',
        });
      });
    });

  for (const t of TARGETS.filter((x) => x.column))
    it(`${t.to}: the keys alone refuse another operation's or tenant's evidence, guard trigger disabled`, async () => {
      const a = await submittingA();
      const a2 = await opA();
      const b = await opB();
      const foreign = [
        await insertObservation(db.pool, {
          tenantId: a.tenantId,
          operationId: a2.operationId,
          classification: t.classification,
        }),
        await insertObservation(db.pool, {
          tenantId: b.tenantId,
          operationId: b.operationId,
          classification: t.classification,
        }),
        await insertObservation(db.pool, {
          tenantId: a.tenantId,
          operationId: null,
          classification: t.classification,
        }),
      ];
      for (const obs of foreign)
        await inRolledBackTx(async (c) => {
          await c.query('alter table refund_operations disable trigger refund_operations_guard');
          await expect(
            c.query(`update refund_operations set ${t.column} = $2 where id = $1`, [a.operationId, obs]),
          ).rejects.toMatchObject({ code: '23503' });
        });
      expect(await stateOf(a.operationId)).toBe('SUBMITTING');
    });
});
