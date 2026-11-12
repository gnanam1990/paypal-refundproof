import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgOperationLedger } from '../../src/db/operation-ledger';
import { OperationConflictError } from '../../src/domain/ledger';
import { money } from '../../src/domain/money';
import type { RevisionContent } from '../../src/domain/proposal';
import { createCase } from '../../src/services/cases';
import { insertRevision } from '../../src/services/revisions';
import { freshDatabase } from '../support/db';
import { approveForTest, seedWorld, type World } from '../support/fixtures';
import { runLedgerRace } from '../support/ledger-contract';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let w: World;
beforeAll(async () => {
  db = await freshDatabase();
  w = await seedWorld(db.pool);
});
afterAll(() => db.drop());

async function approvedRevision(captureId: string) {
  const c = await createCase(db.pool, w.operator, { title: 'race' });
  const content: RevisionContent = {
    tenantId: w.tenantId,
    caseId: c.id,
    captureId,
    amount: { kind: 'EXACT', amount: money('USD', 500n) },
    reason: { code: 'DUPLICATE_CHARGE', noteToPayer: null },
    evidenceDigests: ['d'.repeat(64)],
    policyVersion: 'policy-v1',
  };
  const rev = await insertRevision(db.pool, w.operator, { caseId: c.id, content, origin: 'HUMAN' });
  await approveForTest(db.pool, rev, w.approver);
  return rev;
}

describe('T-005 (durable) — racing workers share one operation and one PayPal request id', () => {
  it.each([2, 4, 8])('%i workers on separate connections', async (n) => {
    const rev = await approvedRevision(`CAPRACE${n}0000000000`.slice(0, 17));
    // Each worker gets its own pool so the race happens across real database sessions.
    const pools = Array.from({ length: n }, () => new pg.Pool({ connectionString: db.url, max: 2 }));
    try {
      const ledgers = pools.map((p) => new PgOperationLedger(p, w.operator.id));
      const ref = { tenantId: w.tenantId, revisionId: rev.id, revisionDigest: rev.digest };
      const results = await Promise.all(ledgers.map((l) => runLedgerRace(l, ref, 1)));
      const ops = await db.pool.query(
        'select id, paypal_request_id from refund_operations where approved_revision_id = $1',
        [rev.id],
      );
      expect(ops.rows).toHaveLength(1);
      expect(results.filter((r) => r.createdCount === 1)).toHaveLength(1);
      const attempts = await db.pool.query(
        'select attempt_no, paypal_request_id from provider_attempts where operation_id = $1 order by attempt_no',
        [ops.rows[0].id],
      );
      expect(attempts.rows.map((a) => a.attempt_no)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect(new Set(attempts.rows.map((a) => a.paypal_request_id))).toEqual(
        new Set([ops.rows[0].paypal_request_id]),
      );
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('rejects the same revision id with a different digest', async () => {
    const rev = await approvedRevision('CAPCONFLICT000001');
    const l = new PgOperationLedger(db.pool, w.operator.id);
    await l.ensureOperation({ tenantId: w.tenantId, revisionId: rev.id, revisionDigest: rev.digest });
    await expect(
      l.ensureOperation({ tenantId: w.tenantId, revisionId: rev.id, revisionDigest: 'e'.repeat(64) }),
    ).rejects.toThrow(OperationConflictError);
  });

  it('refuses to create an operation for a revision that is not approved', async () => {
    const c = await createCase(db.pool, w.operator, { title: 'unapproved' });
    const rev = await insertRevision(db.pool, w.operator, {
      caseId: c.id,
      content: {
        tenantId: w.tenantId,
        caseId: c.id,
        captureId: 'CAPUNAPPROVED0001',
        amount: { kind: 'EXACT', amount: money('USD', 1n) },
        reason: { code: 'OTHER', noteToPayer: null },
        evidenceDigests: ['d'.repeat(64)],
        policyVersion: 'policy-v1',
      },
      origin: 'HUMAN',
    });
    await expect(
      new PgOperationLedger(db.pool, w.operator.id).ensureOperation({
        tenantId: w.tenantId,
        revisionId: rev.id,
        revisionDigest: rev.digest,
      }),
    ).rejects.toThrow(/not approved/);
  });

  it('enforces immutable request identity and attempt/request-id agreement in the database', async () => {
    const rev = await approvedRevision('CAPIMMUTABLE00001');
    const { identity } = await new PgOperationLedger(db.pool, w.operator.id).ensureOperation({
      tenantId: w.tenantId,
      revisionId: rev.id,
      revisionDigest: rev.digest,
    });
    await expect(
      db.pool.query(`update refund_operations set paypal_request_id = 'other' where id = $1`, [
        identity.operationId,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      db.pool.query(
        `insert into provider_attempts (id, operation_id, paypal_request_id, attempt_no, phase, correlation_id) values ('att_x', $1, 'wrong', 1, 'DISPATCHING', 'c')`,
        [identity.operationId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      db.pool.query(`update refund_operations set state = 'CONFIRMED' where id = $1`, [identity.operationId]),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      db.pool.query(`update refund_operations set state = 'CANCELLED_BEFORE_DISPATCH' where id = $1`, [
        identity.operationId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
