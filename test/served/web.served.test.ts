import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../src/db/migrate';
import { TEST_PASSWORD, seedWorld, type World } from '../support/fixtures';
import { PgCluster } from '../support/pg-cluster';
import { freePort, startWeb, stopProcess } from '../support/served';

let cluster: PgCluster;
let w: World;
let env: Record<string, string>;
let port: number;
let origin: string;

beforeAll(async () => {
  cluster = await PgCluster.start();
  const c = new pg.Client({ connectionString: cluster.url() });
  await c.connect();
  await c.query('create database served');
  await c.end();
  const url = cluster.url('served');
  await migrateUp(url);
  const pool = new pg.Pool({ connectionString: url });
  w = await seedWorld(pool);
  await pool.end();
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  env = { DATABASE_URL: url, REFUNDPROOF_DATA_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: origin };
});
afterAll(() => cluster.destroy());

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown } = {},
) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.csrf ? { 'x-csrf-token': opts.csrf } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: (await res.json()) as any, setCookie: res.headers.get('set-cookie') };
}

describe('served API (next start) and web-process restart', () => {
  it('serves the authenticated case/evidence API and keeps state across a web restart', async () => {
    let web = await startWeb(port, env);
    try {
      expect((await call('GET', '/api/cases')).status).toBe(401);
      const login = await call('POST', '/api/auth/login', {
        body: { email: w.operator.email, password: TEST_PASSWORD },
      });
      expect(login.status).toBe(200);
      const cookie = login.setCookie!.split(';')[0]!;
      const csrf = login.json.csrfToken as string;
      const kase = await call('POST', '/api/cases', { cookie, csrf, body: { title: 'Served case' } });
      expect(kase.status).toBe(201);
      const ev = await call('POST', `/api/cases/${kase.json.case.id}/evidence`, {
        cookie,
        csrf,
        body: { kind: 'SUPPORT_MESSAGE', text: 'Charged twice; reach me at pat@example.com' },
      });
      expect(ev.status).toBe(201);

      await stopProcess(web, 'SIGKILL'); // abrupt web termination
      web = await startWeb(port, env);

      const after = await call('GET', `/api/cases/${kase.json.case.id}`, { cookie });
      expect(after.status).toBe(200); // session and data are durable, not process memory
      expect(after.json.evidence[0].digest).toBe(ev.json.evidence.digest);
      expect(JSON.stringify(after.json)).not.toContain('pat@example.com');
      expect(web.output()).not.toContain(env.REFUNDPROOF_DATA_KEY!);
    } finally {
      await stopProcess(web);
    }
  });
});
