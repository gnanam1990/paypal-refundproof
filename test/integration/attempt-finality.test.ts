// Blocker 1 (independent review of PR #4 @ c808bb9): a DISPATCHING provider attempt could be rewritten to
// NOT_SENT, after which SUBMITTING -> READY succeeded and a second dispatch became possible.
// Invariant under test: an attempt that began dispatch can only reach an honest terminal outcome
// (RESPONDED or LOST); NOT_SENT exists only when dispatch never began; terminal evidence is frozen and coherent.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase } from '../support/db';
import { seedWorld, type World } from '../support/fixtures';
import { insertAttempt, makeOperation, setOperationState, type TestOperation } from '../support/operations';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let w: World;
beforeAll(async () => {
  db = await freshDatabase();
  w = await seedWorld(db.pool);
});
afterAll(() => db.drop());

type Phase = 'DISPATCHING' | 'RESPONDED' | 'LOST' | 'NOT_SENT';
const PHASES: Phase[] = ['DISPATCHING', 'RESPONDED', 'LOST', 'NOT_SENT'];

/** A coherent update payload that moves an attempt into `phase`. */
const TERMINAL: Record<Phase, string> = {
  DISPATCHING: `phase = 'DISPATCHING', finished_at = null, http_status = null, error_class = null, response_meta = '{}'`,
  RESPONDED: `phase = 'RESPONDED', finished_at = clock_timestamp(), http_status = 201, response_meta = '{"status":"COMPLETED"}'`,
  LOST: `phase = 'LOST', finished_at = clock_timestamp(), error_class = 'TIMEOUT'`,
  NOT_SENT: `phase = 'NOT_SENT', finished_at = clock_timestamp(), http_status = null, error_class = null, response_meta = '{}'`,
};

async function submitting(): Promise<TestOperation> {
  const op = await makeOperation(db.pool, w.operator, w.approver);
  await setOperationState(db.pool, op.operationId, 'SUBMITTING');
  return op;
}

/** An attempt that legitimately reached `phase`. */
async function attemptIn(phase: Phase, op?: TestOperation) {
  const o = op ?? (await submitting());
  if (phase === 'NOT_SENT') return { op: o, id: await insertAttempt(db.pool, o, 'NOT_SENT') };
  const id = await insertAttempt(db.pool, o, 'DISPATCHING');
  if (phase !== 'DISPATCHING')
    await db.pool.query(`update provider_attempts set ${TERMINAL[phase]} where id = $1`, [id]);
  return { op: o, id };
}

const phaseOf = async (id: string) =>
  (await db.pool.query('select phase from provider_attempts where id = $1', [id])).rows[0].phase as string;
const stateOf = async (opId: string) =>
  (await db.pool.query('select state from refund_operations where id = $1', [opId])).rows[0].state as string;

describe('Blocker 1 — reproduction: DISPATCHING cannot be laundered into NOT_SENT', () => {
  it('refuses DISPATCHING -> NOT_SENT and therefore SUBMITTING -> READY', async () => {
    const op = await submitting();
    const id = await insertAttempt(db.pool, op, 'DISPATCHING');
    await expect(
      db.pool.query(`update provider_attempts set ${TERMINAL.NOT_SENT} where id = $1`, [id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(setOperationState(db.pool, op.operationId, 'READY')).rejects.toMatchObject({
      code: '23514',
    });
    expect(await phaseOf(id)).toBe('DISPATCHING');
    expect(await stateOf(op.operationId)).toBe('SUBMITTING');
  });
});

describe('Blocker 1 — every phase transition', () => {
  const allowed = new Set(['DISPATCHING->RESPONDED', 'DISPATCHING->LOST']);
  for (const from of PHASES)
    for (const to of PHASES) {
      if (from === to) continue;
      const ok = allowed.has(`${from}->${to}`);
      it(`${from} -> ${to} is ${ok ? 'allowed' : 'refused'}`, async () => {
        const { id } = await attemptIn(from);
        const q = db.pool.query(`update provider_attempts set ${TERMINAL[to]} where id = $1`, [id]);
        if (ok) {
          await q;
          expect(await phaseOf(id)).toBe(to);
        } else {
          await expect(q).rejects.toMatchObject({ code: expect.stringMatching(/^(55000|23514)$/) });
          expect(await phaseOf(id)).toBe(from);
        }
      });
    }
});

describe('Blocker 1 — attempts are born DISPATCHING, or NOT_SENT only when dispatch never began', () => {
  it.each(['RESPONDED', 'LOST'] as const)('refuses an attempt born %s', async (phase) => {
    const op = await submitting();
    // A coherent terminal tuple (finished after it started), so only the birth rule can refuse it.
    const finished_at = new Date(Date.now() + 60_000);
    const fields =
      phase === 'RESPONDED' ? { finished_at, http_status: 201 } : { finished_at, error_class: 'TIMEOUT' };
    await expect(insertAttempt(db.pool, op, phase, fields)).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/created DISPATCHING/),
    });
  });

  it('a NOT_SENT attempt is final evidence from birth (finished, no response)', async () => {
    const { id } = await attemptIn('NOT_SENT');
    const r = await db.pool.query('select * from provider_attempts where id = $1', [id]);
    expect(r.rows[0].finished_at).not.toBeNull();
    expect(r.rows[0].http_status).toBeNull();
    expect(r.rows[0].response_meta).toEqual({});
  });

  it.each(['DISPATCHING', 'RESPONDED', 'LOST'] as const)(
    'refuses NOT_SENT once any attempt of the operation is %s',
    async (prior) => {
      const { op } = await attemptIn(prior);
      await expect(insertAttempt(db.pool, op, 'NOT_SENT')).rejects.toMatchObject({ code: '23514' });
    },
  );

  it('allows NOT_SENT after NOT_SENT, and SUBMITTING -> READY then (positive control)', async () => {
    const { op } = await attemptIn('NOT_SENT');
    await insertAttempt(db.pool, op, 'NOT_SENT');
    await setOperationState(db.pool, op.operationId, 'READY');
    expect(await stateOf(op.operationId)).toBe('READY');
  });

  it('refuses a born-NOT_SENT attempt that claims a response', async () => {
    const op = await submitting();
    await expect(insertAttempt(db.pool, op, 'NOT_SENT', { http_status: 201 })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('refuses a born-DISPATCHING attempt that is already finished or responded', async () => {
    const op = await submitting();
    await expect(
      insertAttempt(db.pool, op, 'DISPATCHING', { finished_at: new Date() }),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertAttempt(db.pool, op, 'DISPATCHING', { http_status: 201 })).rejects.toMatchObject({
      code: '23514',
    });
  });
});

describe('Blocker 1 — final evidence fields are frozen', () => {
  const FIELD_EDITS: Record<string, string> = {
    finished_at: `finished_at = finished_at + interval '1 second'`,
    http_status: `http_status = 500`,
    error_class: `error_class = 'REWRITTEN'`,
    response_meta: `response_meta = '{"status":"FAILED"}'`,
    request_meta: `request_meta = '{"amount":"0.01"}'`,
    started_at: `started_at = started_at - interval '1 second'`,
    correlation_id: `correlation_id = 'cor_other'`,
    attempt_no: `attempt_no = attempt_no + 50`,
    paypal_request_id: `paypal_request_id = paypal_request_id`, // no-op control below
  };
  for (const phase of ['RESPONDED', 'LOST', 'NOT_SENT'] as const)
    for (const [field, edit] of Object.entries(FIELD_EDITS)) {
      if (field === 'paypal_request_id') continue;
      it(`${phase}: ${field} cannot change`, async () => {
        const { id } = await attemptIn(phase);
        const before = (await db.pool.query('select * from provider_attempts where id = $1', [id])).rows[0];
        await expect(
          db.pool.query(`update provider_attempts set ${edit} where id = $1`, [id]),
        ).rejects.toMatchObject({ code: expect.stringMatching(/^(55000|23514)$/) });
        const after = (await db.pool.query('select * from provider_attempts where id = $1', [id])).rows[0];
        expect(after).toEqual(before);
      });
    }

  it.each(['request_meta', 'started_at', 'correlation_id', 'error_class', 'response_meta'])(
    'DISPATCHING: %s cannot change without reaching a terminal phase',
    async (field) => {
      const { id } = await attemptIn('DISPATCHING');
      await expect(
        db.pool.query(`update provider_attempts set ${FIELD_EDITS[field]} where id = $1`, [id]),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(55000|23514)$/) });
    },
  );

  it('DISPATCHING -> RESPONDED cannot rewrite what was sent', async () => {
    const { id } = await attemptIn('DISPATCHING');
    await expect(
      db.pool.query(
        `update provider_attempts set ${TERMINAL.RESPONDED}, request_meta = '{"amount":"0.01"}' where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('a no-op update of a final attempt is harmless', async () => {
    const { id } = await attemptIn('RESPONDED');
    await db.pool.query('update provider_attempts set phase = phase where id = $1', [id]);
    expect(await phaseOf(id)).toBe('RESPONDED');
  });

  it('attempts are never deleted', async () => {
    const { id } = await attemptIn('LOST');
    await expect(db.pool.query('delete from provider_attempts where id = $1', [id])).rejects.toMatchObject({
      code: '55000',
    });
  });
});

describe('Blocker 1 — terminal tuples are coherent', () => {
  const INCOHERENT: Record<string, string> = {
    'RESPONDED without status': `phase = 'RESPONDED', finished_at = clock_timestamp()`,
    'RESPONDED with status 0': `phase = 'RESPONDED', finished_at = clock_timestamp(), http_status = 0`,
    'RESPONDED with status 600': `phase = 'RESPONDED', finished_at = clock_timestamp(), http_status = 600`,
    'RESPONDED without finish time': `phase = 'RESPONDED', http_status = 201`,
    'LOST without error class': `phase = 'LOST', finished_at = clock_timestamp()`,
    'LOST with an HTTP status': `phase = 'LOST', finished_at = clock_timestamp(), error_class = 'TIMEOUT', http_status = 201`,
    'LOST without finish time': `phase = 'LOST', error_class = 'TIMEOUT'`,
    'finished before it started': `phase = 'LOST', finished_at = started_at - interval '1 second', error_class = 'TIMEOUT'`,
  };
  for (const [name, edit] of Object.entries(INCOHERENT))
    it(`refuses ${name}`, async () => {
      const { id } = await attemptIn('DISPATCHING');
      await expect(
        db.pool.query(`update provider_attempts set ${edit} where id = $1`, [id]),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await phaseOf(id)).toBe('DISPATCHING');
    });
});

describe('Blocker 1 — concurrency', () => {
  it('racing rewrite, terminal outcomes and SUBMITTING -> READY never yield NOT_SENT or READY', async () => {
    const pools = Array.from({ length: 4 }, () => new pg.Pool({ connectionString: db.url, max: 2 }));
    try {
      for (let round = 0; round < 10; round++) {
        const { op, id } = await attemptIn('DISPATCHING');
        const results = await Promise.allSettled([
          pools[0]!.query(`update provider_attempts set ${TERMINAL.NOT_SENT} where id = $1`, [id]),
          pools[1]!.query(`update provider_attempts set ${TERMINAL.RESPONDED} where id = $1`, [id]),
          pools[2]!.query(`update provider_attempts set ${TERMINAL.LOST} where id = $1`, [id]),
          setOperationState(pools[3]!, op.operationId, 'READY'),
        ]);
        expect(results[0]!.status).toBe('rejected');
        expect(results[3]!.status).toBe('rejected');
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(['RESPONDED', 'LOST']).toContain(await phaseOf(id));
        expect(await stateOf(op.operationId)).toBe('SUBMITTING');
      }
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('a NOT_SENT insert racing an uncommitted DISPATCHING insert waits for it and is then refused', async () => {
    for (let round = 0; round < 5; round++) {
      const op = await submitting();
      const t1 = await db.pool.connect();
      try {
        await t1.query('begin');
        await insertAttempt(t1, op, 'DISPATCHING', { attempt_no: 1 }); // holds the operation row lock
        let settled = false;
        const racer = insertAttempt(db.pool, op, 'NOT_SENT', { attempt_no: 2 }).finally(() => {
          settled = true;
        });
        racer.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 150));
        expect(settled, 'NOT_SENT must wait for the in-flight dispatch to commit').toBe(false);
        await t1.query('commit');
        await expect(racer).rejects.toMatchObject({ code: '23514' });
      } finally {
        t1.release();
      }
      const phases = (
        await db.pool.query(
          'select phase from provider_attempts where operation_id = $1 order by attempt_no',
          [op.operationId],
        )
      ).rows.map((r) => r.phase);
      expect(phases).toEqual(['DISPATCHING']);
    }
  });
});
