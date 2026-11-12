// Security review findings on the M01 branch (commit 44b4a19): S1 rate-limit TOCTOU, S2 unbounded body
// buffering, S3 unsalted evidence digest acting as a plaintext-confirmation oracle.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvidenceCipher } from '../../src/crypto/cipher';
import { domainDigest, sha256Hex } from '../../src/domain/canonical';
import type { ApiContext } from '../../src/http/context';
import { createApi } from '../../src/http/router';
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

describe('S1 — failed-login limit holds under concurrency', () => {
  it('20 parallel wrong-password attempts yield at most `limit` password checks', async () => {
    const c = new TestClient(ctx);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => c.login(w.approver.email, 'definitely wrong')),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
  });

  it('a successful sign-in does not consume the failure budget', async () => {
    const c = new TestClient(ctx);
    for (let i = 0; i < 4; i++)
      expect((await c.login(w.operator.email, 'wrong wrong wrong')).status).toBe(401);
    expect((await c.login(w.operator.email, TEST_PASSWORD)).status).toBe(200);
    expect((await c.login(w.operator.email, 'wrong wrong wrong')).status).toBe(401); // 5th failure still allowed
    expect((await c.login(w.operator.email, 'wrong wrong wrong')).status).toBe(429);
  });
});

describe('S2 — request bodies are capped while streaming', () => {
  const handle = () => createApi(ctx);
  // Lazy 80 MB body; `pulled` counts chunks the server actually consumed before refusing.
  let pulled = 0;
  const big = () => {
    pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(8192));
    return new ReadableStream({
      pull(ctrl) {
        pulled++;
        if (pulled > 10_000) ctrl.close();
        else ctrl.enqueue(chunk);
      },
    });
  };
  const cap = 128 * 1024;
  const maxChunksBeforeRefusal = Math.ceil(cap / 8192) + 2;

  it('rejects an oversized body that has no Content-Length', async () => {
    const res = await handle()(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: big(),
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(maxChunksBeforeRefusal);
  });

  it('rejects an oversized body whose Content-Length lies', async () => {
    const res = await handle()(
      new Request(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': '10' },
        body: big(),
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(maxChunksBeforeRefusal);
  });
});

describe('S3 — evidence digests are keyed, not a plaintext oracle', () => {
  it('cannot be reproduced from a guessed original without the server key', async () => {
    const c = new TestClient(ctx);
    // admin: S1 deliberately exhausted the operator's sign-in budget
    await c.login(w.admin.email, TEST_PASSWORD);
    const kase = (await c.req('POST', '/api/cases', { title: 'oracle' })).json.case;
    // Contains redactable PII, so the redacted copy differs from the original and its digest reveals nothing
    // about the original. (If nothing is redactable the redacted text IS the original, already visible.)
    const text = 'Card 4111 1111 1111 1111 was charged twice; write to ada.lovelace@example.com';
    const ev = (await c.req('POST', `/api/cases/${kase.id}/evidence`, { kind: 'SUPPORT_MESSAGE', text })).json
      .evidence;
    const unkeyed = domainDigest('refundproof/evidence/v1', {
      kind: 'SUPPORT_MESSAGE',
      sha256: sha256Hex(text),
    });
    expect(ev.digest).not.toBe(unkeyed);
    const body = JSON.stringify((await c.req('GET', `/api/cases/${kase.id}`)).json);
    expect(body).not.toContain(sha256Hex(text));
    expect(body).not.toContain(unkeyed);
  });

  it('is stable under one key and different under another', () => {
    const key = randomBytes(32).toString('base64');
    const a = EvidenceCipher.fromBase64Key(key);
    const b = EvidenceCipher.fromBase64Key(key);
    const other = EvidenceCipher.fromBase64Key(randomBytes(32).toString('base64'));
    expect(a.evidenceDigest('SUPPORT_MESSAGE', 'hello')).toBe(b.evidenceDigest('SUPPORT_MESSAGE', 'hello'));
    expect(a.evidenceDigest('SUPPORT_MESSAGE', 'hello')).not.toBe(
      other.evidenceDigest('SUPPORT_MESSAGE', 'hello'),
    );
    expect(a.evidenceDigest('SUPPORT_MESSAGE', 'hello')).not.toBe(a.evidenceDigest('ORDER_NOTE', 'hello'));
    expect(a.evidenceDigest('SUPPORT_MESSAGE', 'hello')).toMatch(/^[0-9a-f]{64}$/);
  });
});
