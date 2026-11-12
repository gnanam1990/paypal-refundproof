// M03 smoke path (build-first round; T-003/T-004 full matrices are deferred to FINAL TEST):
// human revision -> submit -> stale view refused -> exact approval -> operation; FULL needs explicit consent.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgOperationLedger } from '../../src/db/operation-ledger';
import type { ApiContext } from '../../src/http/context';
import { ContractStubCaptureSource } from '../../src/services/captures';
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
    model: null,
    captures: new ContractStubCaptureSource(
      JSON.parse(readFileSync('fixtures/contract-stub-captures.json', 'utf8')),
    ),
  };
});
afterAll(() => db.drop());

async function draftCase(op: TestClient, amount: { kind: 'EXACT'; value: string } | { kind: 'FULL' }) {
  const kase = (await op.req('POST', '/api/cases', { title: 'Duplicate charge' })).json.case;
  await op.req('POST', `/api/cases/${kase.id}/evidence`, {
    kind: 'SUPPORT_MESSAGE',
    text: 'Charged twice for STUB-CAPTURE-0001.',
  });
  const snap = (await op.req('POST', `/api/cases/${kase.id}/captures`, { captureId: 'STUB-CAPTURE-0001' }))
    .json.snapshot;
  const rev = await op.req('POST', `/api/cases/${kase.id}/revisions`, {
    captureSnapshotId: snap.id,
    amount,
    reasonCode: 'DUPLICATE_CHARGE',
    noteToPayer: null,
  });
  expect(rev.status).toBe(201);
  return { kase, rev: rev.json.revision };
}

describe('M03 smoke', () => {
  it('approves exactly the viewed revision and lets the ledger create one operation', async () => {
    const op = new TestClient(ctx);
    await op.login(w.operator.email, TEST_PASSWORD);
    const ap = new TestClient(ctx);
    await ap.login(w.approver.email, TEST_PASSWORD);
    const { rev } = await draftCase(op, { kind: 'EXACT', value: '42.00' });

    expect((await op.req('POST', `/api/revisions/${rev.id}/submit`, {})).status).toBe(200);
    const pending = (await ap.req('GET', '/api/approvals')).json.pending;
    expect(pending.map((p: { revisionId: string }) => p.revisionId)).toContain(rev.id);
    const facts = (await ap.req('GET', `/api/revisions/${rev.id}/approval`)).json.facts;
    expect(facts).toMatchObject({
      amount: { kind: 'EXACT', value: '42.00', currency: 'USD' },
      requiredApproverRole: 'APPROVER',
    });

    expect(
      (
        await op.req('POST', `/api/revisions/${rev.id}/decision`, {
          decision: 'APPROVED',
          revisionDigest: facts.revisionDigest,
        })
      ).status,
    ).toBe(403);
    const stale = await ap.req('POST', `/api/revisions/${rev.id}/decision`, {
      decision: 'APPROVED',
      revisionDigest: 'f'.repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE_APPROVAL_VIEW');

    const ok = await ap.req('POST', `/api/revisions/${rev.id}/decision`, {
      decision: 'APPROVED',
      revisionDigest: facts.revisionDigest,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.facts.approval).toMatchObject({
      decision: 'APPROVED',
      live: true,
      approverId: w.approver.id,
    });

    const { identity } = await new PgOperationLedger(db.pool, w.operator.id).ensureOperation({
      tenantId: w.tenantId,
      revisionId: rev.id,
      revisionDigest: facts.revisionDigest,
    });
    expect(identity.paypalRequestId).toMatch(/^refundproof-/);
  });

  it('refuses a FULL approval without consent and refuses self-approval in the database', async () => {
    const admin = new TestClient(ctx);
    await admin.login(w.admin.email, TEST_PASSWORD);
    const ap = new TestClient(ctx);
    await ap.login(w.approver.email, TEST_PASSWORD);
    const { rev } = await draftCase(admin, { kind: 'FULL' });
    await admin.req('POST', `/api/revisions/${rev.id}/submit`, {});
    const facts = (await ap.req('GET', `/api/revisions/${rev.id}/approval`)).json.facts;
    expect(facts.amount).toMatchObject({ kind: 'FULL', captureAmount: '84.00' });
    const noConsent = await ap.req('POST', `/api/revisions/${rev.id}/decision`, {
      decision: 'APPROVED',
      revisionDigest: facts.revisionDigest,
    });
    expect(noConsent.json.error.code).toBe('FULL_REFUND_CONSENT_REQUIRED');
    // the author (admin) cannot approve its own revision, even writing the row directly
    await expect(
      db.pool.query(
        `insert into approvals (id, tenant_id, revision_id, revision_digest, approval_digest, approver_id, decision, policy_version,
           expires_at, request_id, full_refund_acknowledged)
         select 'apr_self', $1, $2, $3, $3, $4, 'APPROVED', 'policy-v1', now() + interval '10 minutes', q.id, true
           from approval_requests q where q.revision_id = $2`,
        [w.tenantId, rev.id, facts.revisionDigest, w.admin.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const yes = await ap.req('POST', `/api/revisions/${rev.id}/decision`, {
      decision: 'APPROVED',
      revisionDigest: facts.revisionDigest,
      fullRefundConsent: { captureAmount: '84.00' },
    });
    expect(yes.status).toBe(200);
    expect(yes.json.facts.approval.fullRefundAcknowledged).toBe(true);
  });
});
