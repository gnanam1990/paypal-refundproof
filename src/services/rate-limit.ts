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
