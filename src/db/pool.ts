import pg from 'pg';

// bigint columns come back as strings; money code converts explicitly.
pg.types.setTypeParser(20, (v) => v);

export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(
  connectionString: string,
  opts: { max?: number; statementTimeoutMs?: number } = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: 'refundproof',
  });
  // A dropped connection (e.g. database restart) must not crash the process; callers see query errors.
  pool.on('error', () => undefined);
  return pool;
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
