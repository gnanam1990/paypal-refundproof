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
  // A served test must not inherit an operator's .env.local provider choices. In particular, the labelled
  // local fixture is intentionally refused under NODE_ENV=production. Keep this HTTP-boundary test provider-free.
  env = {
    DATABASE_URL: url,
    REFUNDPROOF_DATA_KEY: randomBytes(32).toString('base64'),
    APP_ORIGIN: origin,
    REFUNDPROOF_MODEL_PROVIDER: 'none',
    REFUNDPROOF_CAPTURE_SOURCE: 'none',
    PAYPAL_ENV: 'sandbox',
    PAYPAL_CLIENT_ID: '',
    PAYPAL_CLIENT_SECRET: '',
  };
});
afterAll(() => cluster.destroy());

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; csrf?: string; body?: unknown; origin?: string; rawBody?: string } = {},
) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      origin: opts.origin ?? origin,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.csrf ? { 'x-csrf-token': opts.csrf } : {}),
      ...(opts.body !== undefined || opts.rawBody !== undefined
        ? { 'content-type': 'application/json' }
        : {}),
    },
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  return {
    status: res.status,
    headers: res.headers,
    json: (await res.json()) as any,
    setCookies: res.headers.getSetCookie(),
  };
}

const cookieNamed = (set: string[], name: string) => set.find((c) => c.startsWith(`${name}=`))!;
const attrsOf = (c: string) => c.split(';').map((a) => a.trim().toLowerCase());

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function expectSecurityHeaders(h: Headers, where: string) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(h.get(k), `${where}: ${k}`).toBe(v);
  expect(h.get('x-powered-by'), `${where}: x-powered-by`).toBeNull();
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
      const cookie = cookieNamed(login.setCookies, 'rp_session').split(';')[0]!;
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

  it('enforces the HTTP boundary through the real framework server', async () => {
    const web = await startWeb(port, env);
    try {
      const page = await fetch(`${origin}/`);
      expect(page.status).toBe(200);
      expectSecurityHeaders(page.headers, 'GET /');
      await page.text();

      const unauth = await call('GET', '/api/cases');
      expect(unauth.status).toBe(401);
      expectSecurityHeaders(unauth.headers, 'GET /api/cases');

      const login = await call('POST', '/api/auth/login', {
        body: { email: w.operator.email, password: TEST_PASSWORD },
      });
      expect(login.status).toBe(200);
      expect(login.setCookies.map((c) => c.split('=')[0]).sort()).toEqual(['rp_device', 'rp_session']);
      const session = attrsOf(cookieNamed(login.setCookies, 'rp_session'));
      expect(session[0]).toMatch(/^rp_session=[^;]+$/);
      expect(session).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/']));
      expect(session).not.toContain('secure'); // http origin; Secure is asserted for https in integration
      const device = attrsOf(cookieNamed(login.setCookies, 'rp_device'));
      expect(device).toEqual(expect.arrayContaining(['httponly', 'samesite=lax', 'path=/api/auth']));
      const cookie = cookieNamed(login.setCookies, 'rp_session').split(';')[0]!;
      const csrf = login.json.csrfToken as string;

      const cross = await call('POST', '/api/cases', {
        cookie,
        csrf,
        origin: 'http://evil.example',
        body: { title: 'x' },
      });
      expect(cross.status).toBe(403);
      const noCsrf = await call('POST', '/api/cases', { cookie, body: { title: 'x' } });
      expect(noCsrf.status).toBe(403);

      const big = await call('POST', '/api/cases', {
        cookie,
        csrf,
        rawBody: JSON.stringify({ title: 'x'.repeat(200 * 1024) }),
      });
      expect(big.status).toBe(413);
      expect(JSON.stringify(big.json)).not.toContain('xxxx');
    } finally {
      await stopProcess(web);
    }
  });
});
