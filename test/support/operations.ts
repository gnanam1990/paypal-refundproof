import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Actor } from '../../src/auth/actor';
import { PgOperationLedger } from '../../src/db/operation-ledger';
import { money } from '../../src/domain/money';
import type { RevisionContent } from '../../src/domain/proposal';
import { createCase } from '../../src/services/cases';
import { insertRevision } from '../../src/services/revisions';
import { approveForTest } from './fixtures';

export interface TestOperation {
  operationId: string;
  tenantId: string;
  paypalRequestId: string;
}

let seq = 0;
const captureId = () => `CAP${randomBytes(5).toString('hex').toUpperCase()}${String(++seq).padStart(4, '0')}`;

/**
 * A real refund operation in `actor`'s tenant: case -> revision -> (test-only) approval -> durable ledger.
 * `approver` signs the approval; it must belong to the same tenant.
 */
export async function makeOperation(pool: pg.Pool, actor: Actor, approver: Actor): Promise<TestOperation> {
  const c = await createCase(pool, actor, { title: 'integrity' });
  const content: RevisionContent = {
    tenantId: actor.tenantId,
    caseId: c.id,
    captureId: captureId(),
    amount: { kind: 'EXACT', amount: money('USD', 700n) },
    reason: { code: 'DUPLICATE_CHARGE', noteToPayer: null },
    evidenceDigests: ['d'.repeat(64)],
    policyVersion: 'policy-v1',
  };
  const rev = await insertRevision(pool, actor, { caseId: c.id, content, origin: 'HUMAN' });
  await approveForTest(pool, rev, approver);
  const { identity } = await new PgOperationLedger(pool, actor.id).ensureOperation({
    tenantId: actor.tenantId,
    revisionId: rev.id,
    revisionDigest: rev.digest,
  });
  return {
    operationId: identity.operationId,
    tenantId: actor.tenantId,
    paypalRequestId: identity.paypalRequestId,
  };
}

/** Raw provider observation row (what M04's adapter will write). */
export async function insertObservation(
  db: pg.Pool | pg.PoolClient,
  o: {
    tenantId: string;
    operationId: string | null;
    classification: string;
    kind?: string;
    captureId?: string;
  },
): Promise<string> {
  const id = `obs_${randomBytes(8).toString('hex')}`;
  await db.query(
    `insert into provider_observations (id, tenant_id, operation_id, capture_id, kind, classification, source, summary, correlation_id)
     values ($1, $2, $3, $4, $5, $6, 'CONTRACT_STUB', '{}', 'cor_test')`,
    [id, o.tenantId, o.operationId, o.captureId ?? 'CAPOBS', o.kind ?? 'REFUND_LOOKUP', o.classification],
  );
  return id;
}

export async function setOperationState(
  db: pg.Pool | pg.PoolClient,
  operationId: string,
  state: string,
  extra: Record<string, unknown> = {},
) {
  const cols = Object.keys(extra);
  const sets = ['state = $2', ...cols.map((k, i) => `${k} = $${i + 3}`)].join(', ');
  return db.query(`update refund_operations set ${sets} where id = $1`, [
    operationId,
    state,
    ...cols.map((k) => extra[k]),
  ]);
}

let attemptSeq = 0;
/** Raw attempt insert (bypasses the ledger so the database rules are what is under test). */
export async function insertAttempt(
  db: pg.Pool | pg.PoolClient,
  op: TestOperation,
  phase: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const { attempt_no: explicitNo, ...rest } = fields;
  fields = rest;
  const n =
    explicitNo === undefined
      ? await db.query('select count(*)::int n from provider_attempts where operation_id = $1', [
          op.operationId,
        ])
      : { rows: [{ n: Number(explicitNo) - 1 }] };
  const id = `att_t${++attemptSeq}_${randomBytes(4).toString('hex')}`;
  const cols = [
    'id',
    'operation_id',
    'paypal_request_id',
    'attempt_no',
    'phase',
    'correlation_id',
    ...Object.keys(fields),
  ];
  const vals = [
    id,
    op.operationId,
    op.paypalRequestId,
    n.rows[0].n + 1,
    phase,
    'cor_att',
    ...Object.values(fields),
  ];
  await db.query(
    `insert into provider_attempts (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  );
  return id;
}
