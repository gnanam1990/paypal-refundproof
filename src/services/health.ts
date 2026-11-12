import type { Actor } from '../auth/actor';
import type { Queryable } from '../db/pool';
import { EXPECTED_MIGRATIONS } from '../db/schema-version';

/** Liveness: the web process can reach PostgreSQL. Reveals nothing else. */
export async function liveness(db: Queryable) {
  await db.query('select 1');
  return { status: 'ok' as const };
}

/** Operator-facing health from durable records: migrations, worker heartbeats, queue, operations, capabilities. */
export async function healthDetail(
  db: Queryable,
  actor: Actor,
  capabilities: { model: unknown; captureSource: string | null; paypal: string | null },
) {
  const applied = (await db.query('select version from schema_migrations order by version')).rows.map(
    (r) => r.version as string,
  );
  const known: readonly string[] = EXPECTED_MIGRATIONS;
  const workers = (
    await db.query(
      `select worker_id, started_at, last_seen_at, extract(epoch from (now() - last_seen_at))::int as age_s
         from worker_heartbeats order by last_seen_at desc limit 10`,
    )
  ).rows.map((w) => ({
    workerId: w.worker_id,
    startedAt: new Date(w.started_at).toISOString(),
    lastSeenAt: new Date(w.last_seen_at).toISOString(),
    ageSeconds: w.age_s,
    alive: w.age_s < 30,
  }));
  const jobs = (
    await db.query(
      `select kind, state, count(*)::int n from outbox_jobs where tenant_id = $1 or tenant_id is null group by kind, state order by kind, state`,
      [actor.tenantId],
    )
  ).rows;
  const operations = (
    await db.query(
      `select state, count(*)::int n from refund_operations where tenant_id = $1 group by state order by state`,
      [actor.tenantId],
    )
  ).rows;
  return {
    database: 'ok',
    migrations: { applied, pending: known.filter((v) => !applied.includes(v)) },
    workers,
    jobs,
    operations,
    capabilities,
    checkedAt: new Date().toISOString(),
  };
}
