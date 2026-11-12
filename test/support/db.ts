import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
  }
}

/** A fresh database cloned from the migrated template on the shared test cluster. */
export async function freshDatabase(): Promise<{ url: string; pool: pg.Pool; drop: () => Promise<void> }> {
  const admin = inject('pgAdminUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`create database ${name} template ${inject('pgTemplate')}`);
  await c.end();
  const url = admin.replace(/\/[^/]+$/, `/${name}`);
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  return {
    url,
    pool,
    drop: async () => {
      await pool.end();
      const d = new pg.Client({ connectionString: admin });
      await d.connect();
      await d.query(`drop database if exists ${name} with (force)`);
      await d.end();
    },
  };
}
