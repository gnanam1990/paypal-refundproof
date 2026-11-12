import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiContext } from '../../src/http/context';
import { freshDatabase } from '../support/db';
import { TEST_PASSWORD, seedWorld, testCipher, type World } from '../support/fixtures';
import { ORIGIN, TestClient } from '../support/http';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let w: World;
let ctx: ApiContext;
beforeAll(async () => {
  db = await freshDatabase();
  w = await seedWorld(db.pool);
  ctx = {
    pool: db.pool,
    cipher: testCipher(),
    config: { appOrigin: ORIGIN, sessionTtlMs: 3_600_000, secureCookies: true, loginRateLimit: 5 },
  };
});
afterAll(() => db.drop());

describe('authentication', () => {
  it('logs in with an httpOnly, SameSite, Secure session cookie and records the event', async () => {
    const c = new TestClient(ctx);
    const r = await c.login(w.operator.email, TEST_PASSWORD);
    expect(r.status).toBe(200);
    const cookie = r.headers.getSetCookie().find((x) => x.startsWith('rp_session='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Secure/);
    expect(r.json.actor).toMatchObject({ id: w.operator.id, role: 'OPERATOR' });
    expect(JSON.stringify(r.json)).not.toContain('password');
    const s = await c.req('GET', '/api/session');
    expect(s.json.actor.id).toBe(w.operator.id);
    const stored = await db.pool.query('select token_hash from sessions where actor_id = $1', [
      w.operator.id,
    ]);
    expect(stored.rows.every((x) => !c.cookie.includes(x.token_hash))).toBe(true);
  });

  it('rejects a wrong password without revealing which field was wrong, and audits the denial', async () => {
    const c = new TestClient(ctx);
    const bad = await c.login(w.operator.email, 'wrong password');
    const unknown = await c.login('nobody@refundproof.test', 'wrong password');
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.json).toEqual(unknown.json);
    const a = await db.pool.query(
      `select outcome, details from audit_events where event_type = 'AUTH_LOGIN' and outcome = 'DENIED'`,
    );
    expect(a.rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(a.rows)).not.toContain('wrong password');
  });

  it('rate-limits repeated failed logins for one account', async () => {
    const c = new TestClient(ctx);
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await c.login(w.admin.email, 'nope')).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('revokes the session on logout', async () => {
    const c = new TestClient(ctx);
    await c.login(w.approver.email, TEST_PASSWORD);
    const kept = c.cookie;
    expect((await c.req('POST', '/api/auth/logout')).status).toBe(200);
    c.cookie = kept;
    expect((await c.req('GET', '/api/session')).status).toBe(401);
  });

  it('rejects expired sessions', async () => {
    const c = new TestClient({ ...ctx, config: { ...ctx.config, sessionTtlMs: 1 } });
    await c.login(w.approver.email, TEST_PASSWORD);
    await new Promise((r) => setTimeout(r, 20));
    expect((await c.req('GET', '/api/session')).status).toBe(401);
  });
});

describe('request integrity', () => {
  it('requires the session CSRF token on mutations', async () => {
    const c = new TestClient(ctx);
    await c.login(w.operator.email, TEST_PASSWORD);
    const token = c.csrf;
    c.csrf = '';
    expect((await c.req('POST', '/api/cases', { title: 'no csrf' })).status).toBe(403);
    expect((await c.req('POST', '/api/cases', { title: 'bad csrf' }, { 'x-csrf-token': 'x' })).status).toBe(
      403,
    );
    c.csrf = token;
    expect((await c.req('POST', '/api/cases', { title: 'with csrf' })).status).toBe(201);
  });

  it('rejects cross-origin mutations even with a valid session', async () => {
    const c = new TestClient(ctx);
    await c.login(w.operator.email, TEST_PASSWORD);
    expect(
      (await c.req('POST', '/api/cases', { title: 'x' }, { origin: 'https://evil.example' })).status,
    ).toBe(403);
  });

  it('validates input with closed schemas', async () => {
    const c = new TestClient(ctx);
    await c.login(w.operator.email, TEST_PASSWORD);
    const r = await c.req('POST', '/api/cases', { title: 'ok', approve: true });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('VALIDATION');
  });
});

describe('tenancy and roles', () => {
  it('hides other tenants’ cases as not found', async () => {
    const op = new TestClient(ctx);
    await op.login(w.operator.email, TEST_PASSWORD);
    const created = await op.req('POST', '/api/cases', { title: 'tenant A case' });
    const out = new TestClient(ctx);
    await out.login(w.outsider.email, TEST_PASSWORD);
    expect((await out.req('GET', `/api/cases/${created.json.case.id}`)).status).toBe(404);
    const list = await out.req('GET', '/api/cases');
    expect(JSON.stringify(list.json)).not.toContain(created.json.case.id);
    expect(
      (
        await out.req('POST', `/api/cases/${created.json.case.id}/evidence`, {
          kind: 'SUPPORT_MESSAGE',
          text: 'x',
        })
      ).status,
    ).toBe(404);
    const denied = await db.pool.query(
      `select count(*)::int n from audit_events where outcome = 'DENIED' and actor_id = $1`,
      [w.outsider.id],
    );
    expect(denied.rows[0].n).toBeGreaterThan(0);
  });

  it('lets approvers read but not import cases', async () => {
    const ap = new TestClient(ctx);
    await ap.login(w.approver.email, TEST_PASSWORD);
    expect((await ap.req('POST', '/api/cases', { title: 'approver import' })).status).toBe(403);
    expect((await ap.req('GET', '/api/cases')).status).toBe(200);
  });

  it('requires authentication everywhere except login', async () => {
    const anon = new TestClient(ctx);
    for (const [m, p] of [
      ['GET', '/api/cases'],
      ['GET', '/api/session'],
      ['POST', '/api/cases'],
    ] as const) {
      expect((await anon.req(m, p, m === 'POST' ? { title: 'x' } : undefined)).status).toBe(401);
    }
  });
});

describe('evidence admission (FR-06 durable trail)', () => {
  it('encrypts the original, stores a redacted copy, and exposes only redacted text', async () => {
    const op = new TestClient(ctx);
    await op.login(w.operator.email, TEST_PASSWORD);
    const kase = (
      await op.req('POST', '/api/cases', { title: 'Card charged twice', customerRef: 'ORDER-1001' })
    ).json.case;
    const text =
      'Hi, I was charged twice. Email me at jane.doe@example.com or call +1 415 555 0101. Card 4111 1111 1111 1111.';
    const r = await op.req('POST', `/api/cases/${kase.id}/evidence`, { kind: 'SUPPORT_MESSAGE', text });
    expect(r.status).toBe(201);
    expect(r.json.evidence.digest).toMatch(/^[0-9a-f]{64}$/);
    const detail = await op.req('GET', `/api/cases/${kase.id}`);
    const body = JSON.stringify(detail.json);
    expect(body).not.toContain('jane.doe@example.com');
    expect(body).not.toContain('4111 1111 1111 1111');
    expect(body).not.toContain('555 0101');
    expect(body).toContain('charged twice');
    const row = await db.pool.query(
      'select encrypted_original, redacted_text from evidence_artifacts where id = $1',
      [r.json.evidence.id],
    );
    expect(row.rows[0].encrypted_original.toString('utf8')).not.toContain('charged twice');
    expect(ctx.cipher.decrypt(row.rows[0].encrypted_original).toString('utf8')).toBe(text);
    const dup = await op.req('POST', `/api/cases/${kase.id}/evidence`, { kind: 'SUPPORT_MESSAGE', text });
    expect(dup.status).toBe(200);
    expect(dup.json.evidence.id).toBe(r.json.evidence.id);
  });

  it('bounds evidence size', async () => {
    const op = new TestClient(ctx);
    await op.login(w.operator.email, TEST_PASSWORD);
    const kase = (await op.req('POST', '/api/cases', { title: 'big' })).json.case;
    expect(
      (
        await op.req('POST', `/api/cases/${kase.id}/evidence`, {
          kind: 'SUPPORT_MESSAGE',
          text: 'x'.repeat(70_000),
        })
      ).status,
    ).toBe(422);
  });

  it('shows an audit trail for the case', async () => {
    const op = new TestClient(ctx);
    await op.login(w.operator.email, TEST_PASSWORD);
    const kase = (await op.req('POST', '/api/cases', { title: 'trail' })).json.case;
    await op.req('POST', `/api/cases/${kase.id}/evidence`, {
      kind: 'OPERATOR_NOTE',
      text: 'customer called',
    });
    const a = await op.req('GET', `/api/cases/${kase.id}/audit`);
    expect(a.json.events.map((e: { eventType: string }) => e.eventType)).toEqual([
      'CASE_CREATED',
      'EVIDENCE_ADMITTED',
    ]);
  });
});
