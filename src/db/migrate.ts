import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration {
  version: string;
  name: string;
  up: string;
  down: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir);
  return files
    .filter((f) => f.endsWith('.up.sql'))
    .sort()
    .map((f) => {
      const m = /^(\d{4})_([a-z0-9_]+)\.up\.sql$/.exec(f);
      if (!m) throw new Error(`bad migration filename ${f}`);
      const down = `${m[1]}_${m[2]}.down.sql`;
      if (!files.includes(down)) throw new Error(`missing rollback ${down}`);
      const up = readFileSync(join(dir, f), 'utf8');
      return {
        version: m[1]!,
        name: m[2]!,
        up,
        down: readFileSync(join(dir, down), 'utf8'),
        checksum: createHash('sha256').update(up).digest('hex'),
      };
    });
}

const LOCK_KEY = 727_001; // advisory lock serializing concurrent migrators

async function ensureTable(c: pg.ClientBase) {
  await c.query(`create table if not exists schema_migrations (
    version text primary key, name text not null, checksum text not null, applied_at timestamptz not null default now())`);
}

export async function migrateUp(url: string, migrations = loadMigrations()): Promise<string[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(c);
    const done = new Map(
      (
        await c.query<{ version: string; checksum: string }>(
          'select version, checksum from schema_migrations',
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );
    for (const m of migrations) {
      const prior = done.get(m.version);
      if (prior) {
        if (prior !== m.checksum)
          throw new Error(`migration ${m.version}_${m.name} was modified after being applied`);
        continue;
      }
      await c.query('begin');
      try {
        await c.query(m.up);
        await c.query('insert into schema_migrations (version, name, checksum) values ($1, $2, $3)', [
          m.version,
          m.name,
          m.checksum,
        ]);
        await c.query('commit');
        applied.push(`${m.version}_${m.name}`);
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await c.end();
  }
  return applied;
}

/** Roll back the latest `steps` migrations, each in its own transaction. */
export async function migrateDown(url: string, steps = 1, migrations = loadMigrations()): Promise<string[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const rolled: string[] = [];
  try {
    await c.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await ensureTable(c);
    const applied = (
      await c.query<{ version: string }>('select version from schema_migrations order by version desc')
    ).rows;
    for (const { version } of applied.slice(0, steps)) {
      const m = migrations.find((x) => x.version === version);
      if (!m) throw new Error(`no rollback available for applied migration ${version}`);
      await c.query('begin');
      try {
        await c.query(m.down);
        await c.query('delete from schema_migrations where version = $1', [version]);
        await c.query('commit');
        rolled.push(`${m.version}_${m.name}`);
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await c.end();
  }
  return rolled;
}

export async function migrationStatus(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await ensureTable(c);
    const rows = (await c.query('select version, name, applied_at from schema_migrations order by version'))
      .rows;
    return {
      applied: rows,
      pending: loadMigrations()
        .filter((m) => !rows.some((r) => r.version === m.version))
        .map((m) => `${m.version}_${m.name}`),
    };
  } finally {
    await c.end();
  }
}
