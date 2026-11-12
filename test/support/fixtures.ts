import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { EvidenceCipher } from '../../src/crypto/cipher';
import { createActor, createTenant } from '../../src/services/tenancy';
import type { Actor } from '../../src/auth/actor';

export const TEST_PASSWORD = 'correct horse battery staple';

export const testCipher = () => EvidenceCipher.fromBase64Key(randomBytes(32).toString('base64'));

export interface World {
  tenantId: string;
  operator: Actor;
  approver: Actor;
  admin: Actor;
  otherTenantId: string;
  outsider: Actor;
  /** Tenant B's approver (separation of duties: an author never decides its own revision). */
  outsiderApprover: Actor;
}

/** Labeled test-only identities created through the real tenancy service. */
export async function seedWorld(pool: pg.Pool): Promise<World> {
  const tag = randomBytes(3).toString('hex');
  const t = await createTenant(pool, `Test merchant ${tag}`);
  const o = await createTenant(pool, `Other merchant ${tag}`);
  const mk = (tenantId: string, role: Actor['role'], name: string) =>
    createActor(pool, {
      tenantId,
      role,
      email: `${name}-${tag}@refundproof.test`,
      displayName: name,
      password: TEST_PASSWORD,
    });
  return {
    tenantId: t.id,
    operator: await mk(t.id, 'OPERATOR', 'operator'),
    approver: await mk(t.id, 'APPROVER', 'approver'),
    admin: await mk(t.id, 'ADMIN', 'admin'),
    otherTenantId: o.id,
    outsider: await mk(o.id, 'OPERATOR', 'outsider'),
    outsiderApprover: await mk(o.id, 'APPROVER', 'outsider-approver'),
  };
}

import { approvalDigest } from '../../src/domain/identity';
import type { StoredRevision } from '../../src/services/revisions';

/**
 * TEST-ONLY shortcut to an approved revision for persistence tests that precede the approval service (M03).
 * It writes the same rows the approval service writes; it is never used by the product path.
 */
export async function approveForTest(
  pool: pg.Pool,
  rev: StoredRevision,
  approver: Actor,
  ttlMs = 30 * 60_000,
) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const id = `apr_test_${randomBytes(6).toString('hex')}`;
  const digest = approvalDigest({
    tenantId: rev.tenantId,
    revisionId: rev.id,
    revisionDigest: rev.digest,
    approverId: approver.id,
    policyVersion: 'policy-v1',
    expiresAt,
  });
  await pool.query(`update proposal_revisions set state = 'REVIEWABLE' where id = $1 and state = 'DRAFT'`, [
    rev.id,
  ]);
  // Databases rehearsing an upgrade may predate approval requests (0006); write the rows that schema had.
  const modern = (await pool.query(`select to_regclass('approval_requests') as t`)).rows[0].t !== null;
  if (!modern) {
    await pool.query(
      `insert into approvals (id, tenant_id, revision_id, revision_digest, approval_digest, approver_id, decision, policy_version, expires_at)
       values ($1, $2, $3, $4, $5, $6, 'APPROVED', 'policy-v1', $7)`,
      [id, rev.tenantId, rev.id, rev.digest, digest, approver.id, expiresAt],
    );
    await pool.query(`update proposal_revisions set state = 'APPROVED' where id = $1`, [rev.id]);
    return { approvalId: id, expiresAt };
  }
  const requestId = `areq_test_${randomBytes(6).toString('hex')}`;
  await pool.query(
    `insert into approval_requests (id, tenant_id, case_id, revision_id, revision_digest, requested_by)
     values ($1, $2, $3, $4, $5, $6) on conflict (revision_id) do nothing`,
    [requestId, rev.tenantId, rev.caseId, rev.id, rev.digest, rev.authoredBy],
  );
  const req = await pool.query('select id from approval_requests where revision_id = $1', [rev.id]);
  await pool.query(
    `insert into approvals (id, tenant_id, revision_id, revision_digest, approval_digest, approver_id, decision,
       policy_version, expires_at, request_id, full_refund_acknowledged)
     values ($1, $2, $3, $4, $5, $6, 'APPROVED', 'policy-v1', $7, $8, $9)`,
    [
      id,
      rev.tenantId,
      rev.id,
      rev.digest,
      digest,
      approver.id,
      expiresAt,
      req.rows[0].id,
      rev.content.amount.kind === 'FULL',
    ],
  );
  await pool.query(`update proposal_revisions set state = 'APPROVED' where id = $1`, [rev.id]);
  return { approvalId: id, expiresAt };
}
