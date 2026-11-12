import type pg from 'pg';
import type { Queryable } from '../db/pool';
import { AppError } from '../auth/actor';

/** Fixed-window counter in PostgreSQL, so limits hold across web processes and restarts. */
export async function countInWindow(db: Queryable, key: string, windowMs: number): Promise<number> {
  const r = await db.query(
    `select coalesce(sum(hits), 0)::int as n from rate_limit_buckets
      where bucket_key = $1 and window_start > now() - make_interval(secs => $2::double precision / 1000)`,
    [key, windowMs],
  );
  return r.rows[0].n;
}

export async function recordHit(db: Queryable, key: string, bucketMs = 60_000) {
  await db.query(
    `insert into rate_limit_buckets (bucket_key, window_start, hits)
     values ($1, to_timestamp(floor(extract(epoch from now()) * 1000 / $2) * $2 / 1000), 1)
     on conflict (bucket_key, window_start) do update set hits = rate_limit_buckets.hits + 1`,
    [key, bucketMs],
  );
}

export const rateLimited = (what: string) =>
  new AppError(429, 'RATE_LIMITED', `Too many ${what}; try again later`);

/**
 * Atomically reserves one hit for `key`: a transaction-scoped advisory lock serializes concurrent callers on
 * the same key, so N parallel requests cannot all pass the check before any of them records (TOCTOU).
 * Returns a release function that gives the hit back (e.g. when the sign-in turns out to be valid).
 */
export async function reserveHit(
  pool: pg.Pool,
  key: string,
  limit: number,
  windowMs: number,
  what: string,
): Promise<() => Promise<void>> {
  const c = await pool.connect();
  let bucket: Date;
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtextextended($1, 727))', [key]);
    if ((await countInWindow(c, key, windowMs)) >= limit) throw rateLimited(what);
    const r = await c.query(
      `insert into rate_limit_buckets (bucket_key, window_start, hits)
       values ($1, to_timestamp(floor(extract(epoch from now()) * 1000 / 60000) * 60000 / 1000), 1)
       on conflict (bucket_key, window_start) do update set hits = rate_limit_buckets.hits + 1
       returning window_start`,
      [key],
    );
    bucket = r.rows[0].window_start;
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
  return async () => {
    await pool.query(
      `update rate_limit_buckets set hits = greatest(hits - 1, 0) where bucket_key = $1 and window_start = $2`,
      [key, bucket],
    );
  };
}

/** Counts this request and throws 429 when the window already holds `limit` hits. */
export async function enforceRateLimit(
  db: Queryable,
  key: string,
  limit: number,
  windowMs: number,
  what: string,
) {
  if ((await countInWindow(db, key, windowMs)) >= limit) throw rateLimited(what);
  await recordHit(db, key);
}
