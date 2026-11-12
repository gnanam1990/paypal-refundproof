import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money } from '../../src/domain/money';
import { encodeRevisionContent, revisionDigest, type RevisionContent } from '../../src/domain/proposal';
import { createCase } from '../../src/services/cases';
import { insertRevision } from '../../src/services/revisions';
import { freshDatabase } from '../support/db';
import { seedWorld, type World } from '../support/fixtures';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let w: World;
beforeAll(async () => {
  db = await freshDatabase();
  w = await seedWorld(db.pool);
});
afterAll(() => db.drop());

const content = (tenantId: string, caseId: string, minor = 1000n): RevisionContent => ({
  tenantId,
  caseId,
  captureId: 'CAPTURE00000000001',
  amount: { kind: 'EXACT', amount: money('USD', minor) },
  reason: { code: 'ITEM_DEFECTIVE', noteToPayer: null },
  evidenceDigests: ['a'.repeat(64)],
  policyVersion: 'policy-v1',
});

async function draft(minor = 1000n) {
  const c = await createCase(db.pool, w.operator, { title: 'Damaged item' });
  const rev = await insertRevision(db.pool, w.operator, {
    caseId: c.id,
    content: content(w.tenantId, c.id, minor),
    origin: 'HUMAN',
  });
  return { c, rev };
}

describe('database-enforced safety constraints', () => {
  it('rejects cross-tenant references at the foreign key level', async () => {
    const c = await createCase(db.pool, w.operator, { title: 'x' });
    await expect(
      db.pool.query(
        `insert into evidence_artifacts (id, tenant_id, case_id, kind, digest, redacted_text, redacted_digest,
           encrypted_original, encryption_key_id, original_bytes, redaction_report, admitted_by)
         values ('ev_x', $1, $2, 'SUPPORT_MESSAGE', $3, 'x', $3, '\\x00', 'k', 1, '{}', $4)`,
        [w.otherTenantId, c.id, 'b'.repeat(64), w.outsider.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps audit and transition history append-only', async () => {
    await db.pool.query(
      `insert into audit_events (tenant_id, event_type, subject_type, subject_id) values ($1, 'T', 'x', 'y')`,
      [w.tenantId],
    );
    await expect(db.pool.query(`update audit_events set event_type = 'U'`)).rejects.toMatchObject({
      code: '55000',
    });
    await expect(db.pool.query(`delete from audit_events`)).rejects.toMatchObject({ code: '55000' });
    await expect(db.pool.query(`delete from state_transitions`)).rejects.toMatchObject({ code: '55000' });
  });

  it('makes revision content immutable and records every transition', async () => {
    const { rev } = await draft();
    await expect(
      db.pool.query(`update proposal_revisions set digest = $2 where id = $1`, [rev.id, 'c'.repeat(64)]),
    ).rejects.toMatchObject({
      code: '55000',
    });
    await expect(
      db.pool.query(`update proposal_revisions set state = 'APPROVED' where id = $1`, [rev.id]),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await db.pool.query(`update proposal_revisions set state = 'REVIEWABLE' where id = $1`, [rev.id]);
    const t = await db.pool.query(
      `select from_state, to_state from state_transitions where subject_id = $1 order by id`,
      [rev.id],
    );
    expect(t.rows).toEqual([
      { from_state: null, to_state: 'DRAFT' },
      { from_state: 'DRAFT', to_state: 'REVIEWABLE' },
    ]);
  });

  it('allows one live revision per case', async () => {
    const { c } = await draft();
    await expect(
      insertRevision(db.pool, w.operator, {
        caseId: c.id,
        content: content(w.tenantId, c.id, 999n),
        origin: 'HUMAN',
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses to leave DRAFT while human correction is required', async () => {
    const c = await createCase(db.pool, w.operator, { title: 'y' });
    const rev = await insertRevision(db.pool, w.operator, {
      caseId: c.id,
      content: content(w.tenantId, c.id),
      origin: 'AI',
      correctionReasons: ['UNCITED_CLAIM'],
    });
    await expect(
      db.pool.query(`update proposal_revisions set state = 'REVIEWABLE' where id = $1`, [rev.id]),
    ).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('stores the digest the domain computes and verifies it on read', async () => {
    const { c, rev } = await draft(4242n);
    expect(rev.digest).toBe(revisionDigest(content(w.tenantId, c.id, 4242n)));
    const row = await db.pool.query(`select content from proposal_revisions where id = $1`, [rev.id]);
    expect(row.rows[0].content).toEqual(encodeRevisionContent(content(w.tenantId, c.id, 4242n)));
  });

  it('refuses a revision whose content names another tenant or case', async () => {
    const c = await createCase(db.pool, w.operator, { title: 'z' });
    await expect(
      insertRevision(db.pool, w.operator, {
        caseId: c.id,
        content: content(w.otherTenantId, c.id),
        origin: 'HUMAN',
      }),
    ).rejects.toThrow(/tenant/);
    await expect(
      insertRevision(db.pool, w.operator, {
        caseId: c.id,
        content: content(w.tenantId, 'case_other'),
        origin: 'HUMAN',
      }),
    ).rejects.toThrow(/case/);
  });
});
