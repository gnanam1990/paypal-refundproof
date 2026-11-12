import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from '../../src/db/migrate';
import {
  OPERATION_EDGE_EVIDENCE,
  OPERATION_TRANSITIONS,
  PROPOSAL_TRANSITIONS,
} from '../../src/domain/states';
import { freshDatabase } from '../support/db';

describe('migrations', () => {
  it('apply from empty, roll back completely, and re-apply', async () => {
    const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
    await admin.connect();
    await admin.query('create database mig_roundtrip');
    await admin.end();
    const url = inject('pgAdminUrl').replace(/\/[^/]+$/, '/mig_roundtrip');
    const all = loadMigrations().map((m) => `${m.version}_${m.name}`);
    expect(await migrateUp(url)).toEqual(all);
    expect(await migrateUp(url)).toEqual([]);
    expect((await migrationStatus(url)).pending).toEqual([]);
    expect(await migrateDown(url, all.length)).toEqual([...all].reverse());
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const left = await c.query(
      `select count(*)::int as n from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`,
    );
    await c.end();
    expect(left.rows[0].n).toBe(0);
    expect(await migrateUp(url)).toEqual(all);
  });

  it('refuses a migration whose content changed after being applied', async () => {
    const db = await freshDatabase();
    try {
      const tampered = loadMigrations().map((m, i) => (i === 0 ? { ...m, checksum: 'f'.repeat(64) } : m));
      await expect(migrateUp(db.url, tampered)).rejects.toThrow(/modified after being applied/);
    } finally {
      await db.drop();
    }
  });

  it('mirrors the domain transition tables exactly (drift tripwire)', async () => {
    const db = await freshDatabase();
    try {
      const ops = await db.pool.query(
        'select from_state, to_state, evidence from operation_transition_rules',
      );
      const dbOps = ops.rows.map((r) => `${r.from_state}->${r.to_state}:${r.evidence ?? ''}`).sort();
      const domOps = Object.entries(OPERATION_TRANSITIONS)
        .flatMap(([f, tos]) =>
          tos.map(
            (t) =>
              `${f}->${t}:${OPERATION_EDGE_EVIDENCE[`${f}->${t}` as keyof typeof OPERATION_EDGE_EVIDENCE] ?? ''}`,
          ),
        )
        .sort();
      expect(dbOps).toEqual(domOps);
      const props = await db.pool.query('select from_state, to_state from proposal_transition_rules');
      expect(props.rows.map((r) => `${r.from_state}->${r.to_state}`).sort()).toEqual(
        Object.entries(PROPOSAL_TRANSITIONS)
          .flatMap(([f, tos]) => tos.map((t) => `${f}->${t}`))
          .sort(),
      );
    } finally {
      await db.drop();
    }
  });
});
