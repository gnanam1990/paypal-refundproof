// Security review finding L1 on 02d31af (automated push review): the failed-login limiter was keyed on the
// account alone, so anyone who knows an email could keep that account locked out (5 wrong passwords per
// 15 minutes). Fix under test: device cookies. A client that signed in successfully before carries a signed,
// account-bound `rp_device` cookie and has its own failure bucket; every other client shares the account's
// untrusted bucket. The S1 property (password checks bounded per bucket, even in parallel) must still hold.
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
    config: { appOrigin: ORIGIN, sessionTtlMs: 3_600_000, secureCookies: false, loginRateLimit: 5 },
  };
});
afterAll(() => db.drop());

/** The approver's device cookie from the first test, reused by the forgery test (its untrusted bucket is spent). */
let approverDevice = '';

/** Signs in once on a fresh client, returning it holding only its device cookie (session dropped). */
async function trustedDevice(email: string, c = new TestClient(ctx)) {
  expect((await c.login(email, TEST_PASSWORD)).status).toBe(200);
  const device = c.jar.get('rp_device');
  expect(device, 'a successful sign-in issues rp_device').toBeTruthy();
  c.cookie = `rp_device=${device}`;
  c.csrf = '';
  return c;
}

async function exhaustUntrusted(email: string) {
  const attacker = new TestClient(ctx);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await attacker.login(email, 'attacker guess')).status);
  expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
}

describe('L1 — a remote attacker cannot lock an account out of its known devices', () => {
  it('the owner signs in from a trusted device while the untrusted bucket is exhausted', async () => {
    const owner = await trustedDevice(w.approver.email);
    approverDevice = owner.jar.get('rp_device')!;
    await exhaustUntrusted(w.approver.email);
    expect((await new TestClient(ctx).login(w.approver.email, TEST_PASSWORD)).status).toBe(429);
    expect((await owner.login(w.approver.email, TEST_PASSWORD)).status).toBe(200);
  });

  it('a trusted device still has its own bound: no password oracle once it is exhausted', async () => {
    const dev = await trustedDevice(w.operator.email);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await dev.login(w.operator.email, 'wrong')).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await dev.login(w.operator.email, TEST_PASSWORD)).status).toBe(429);
    // the untrusted bucket is separate and untouched
    expect((await new TestClient(ctx).login(w.operator.email, 'wrong')).status).toBe(401);
  });

  it('parallel guesses on one device cookie are bounded like S1', async () => {
    const dev = await trustedDevice(w.admin.email);
    const header = dev.cookie;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => {
        const c = new TestClient(ctx);
        c.cookie = header;
        return c.login(w.admin.email, 'parallel wrong');
      }),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
  });
});

describe('L1 — device cookies cannot be forged or transplanted', () => {
  it('tampered, transplanted and malformed cookies fall back to the exhausted untrusted bucket', async () => {
    // Victim: the approver, whose untrusted bucket the first test exhausted.
    const victim = w.approver.email;
    const ownDevice = approverDevice;
    expect(ownDevice.split('.')).toHaveLength(4);
    const otherAccount = (await trustedDevice(w.operator.email)).jar.get('rp_device')!;
    const parts = ownDevice.split('.');
    const flip = (h: string) => (h.at(-1) === '0' ? h.slice(0, -1) + '1' : h.slice(0, -1) + '0');
    const forged = [
      otherAccount, // valid cookie, wrong account
      [parts[0], w.approver.id, ...otherAccount.split('.').slice(2)].join('.'), // account id swapped in
      [...parts.slice(0, -1), flip(parts.at(-1)!)].join('.'), // MAC altered
      [parts[0], parts[1], 'AAAAAAAAAAAAAAAAAAAAAA', parts[3]].join('.'), // nonce altered
      'v1.garbage',
      '',
    ];
    for (const value of forged) {
      const c = new TestClient(ctx);
      c.cookie = `rp_device=${value}`;
      expect((await c.login(victim, TEST_PASSWORD)).status, `forged: ${value.slice(0, 24)}`).toBe(429);
    }
  });

  it('is HttpOnly, SameSite=Lax, scoped to /api/auth, long-lived, and not a session credential', async () => {
    const secure = { ...ctx, config: { ...ctx.config, secureCookies: true } };
    const fresh = await new TestClient(secure).login(w.admin.email, TEST_PASSWORD);
    expect(fresh.status).toBe(200);
    const set = fresh.headers.getSetCookie().find((x) => x.startsWith('rp_device='))!;
    const attrs = set.split(';').map((a) => a.trim().toLowerCase());
    expect(attrs).toContain('httponly');
    expect(attrs).toContain('samesite=lax');
    expect(attrs).toContain('path=/api/auth');
    expect(attrs).toContain('secure');
    const maxAge = Number(attrs.find((a) => a.startsWith('max-age='))!.split('=')[1]);
    expect(maxAge).toBeGreaterThanOrEqual(30 * 24 * 3600);
    expect(set).not.toContain(w.admin.email);

    const onlyDevice = new TestClient(ctx);
    onlyDevice.cookie = set.split(';')[0]!;
    expect((await onlyDevice.req('GET', '/api/session')).status).toBe(401);
  });

  it('logout keeps the device cookie (it is not a credential)', async () => {
    const c = new TestClient(ctx);
    const r = await c.login(w.admin.email, TEST_PASSWORD);
    expect(r.status).toBe(200);
    const out = await c.req('POST', '/api/auth/logout');
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().some((x) => x.startsWith('rp_device='))).toBe(false);
    expect(c.jar.has('rp_device')).toBe(true);
  });
});
