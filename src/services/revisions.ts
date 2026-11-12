import type pg from 'pg';
import type { Actor } from '../auth/actor';
import { withTx, type Queryable } from '../db/pool';
import {
  decodeRevisionContent,
  encodeRevisionContent,
  normalizeRevisionContent,
  revisionDigest,
  type RevisionContent,
  type RevisionContentWire,
} from '../domain/proposal';
import type { ProposalState } from '../domain/states';
import { newId } from '../ids';
import { appendAudit } from './audit';
import { getCaseForActor } from './cases';

export class DigestMismatchError extends Error {
  override readonly name = 'DigestMismatchError';
}

export interface StoredRevision {
  id: string;
  tenantId: string;
  caseId: string;
  revisionNo: number;
  state: ProposalState;
  content: RevisionContent;
  wire: RevisionContentWire;
  digest: string;
  origin: 'AI' | 'HUMAN';
  parentRevisionId: string | null;
  captureSnapshotId: string | null;
  modelInvocationId: string | null;
  correctionReasons: string[];
  explanation: string | null;
  authoredBy: string;
  createdAt: string;
}

/** Decodes a stored row and re-derives its digest; a mismatch means the stored identity cannot be trusted. */
export function toStoredRevision(r: Record<string, unknown>): StoredRevision {
  const wire = r.content as RevisionContentWire;
  const content = decodeRevisionContent(wire);
  const digest = revisionDigest(content);
  if (digest !== r.digest)
    throw new DigestMismatchError(`revision ${String(r.id)} digest does not match its content`);
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    caseId: r.case_id as string,
    revisionNo: r.revision_no as number,
    state: r.state as ProposalState,
    content,
    wire,
    digest,
    origin: r.origin as 'AI' | 'HUMAN',
    parentRevisionId: (r.parent_revision_id as string | null) ?? null,
    captureSnapshotId: (r.capture_snapshot_id as string | null) ?? null,
    modelInvocationId: (r.model_invocation_id as string | null) ?? null,
    correctionReasons: (r.correction_reasons as string[]) ?? [],
    explanation: (r.explanation as string | null) ?? null,
    authoredBy: r.authored_by as string,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export interface NewRevision {
  caseId: string;
  content: RevisionContent;
  origin: 'AI' | 'HUMAN';
  correctionReasons?: string[];
  explanation?: string | null;
  parentRevisionId?: string | null;
  captureSnapshotId?: string | null;
  modelInvocationId?: string | null;
}

/** Inserts an immutable DRAFT revision inside an existing transaction. The case row must be locked by the caller. */
export async function insertRevisionTx(c: Queryable, actor: Actor, n: NewRevision): Promise<StoredRevision> {
  const content = normalizeRevisionContent(n.content);
  if (content.tenantId !== actor.tenantId) throw new Error('revision content names a different tenant');
  if (content.caseId !== n.caseId) throw new Error('revision content names a different case');
  const no = await c.query(
    'select coalesce(max(revision_no), 0) + 1 as n from proposal_revisions where case_id = $1',
    [n.caseId],
  );
  const id = newId('rev');
  const r = await c.query(
    `insert into proposal_revisions (id, tenant_id, case_id, revision_no, state, content, digest, capture_id, amount_kind,
       capture_snapshot_id, origin, parent_revision_id, model_invocation_id, correction_reasons, explanation, authored_by)
     values ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning *`,
    [
      id,
      actor.tenantId,
      n.caseId,
      no.rows[0].n,
      JSON.stringify(encodeRevisionContent(content)),
      revisionDigest(content),
      content.captureId,
      content.amount.kind,
      n.captureSnapshotId ?? null,
      n.origin,
      n.parentRevisionId ?? null,
      n.modelInvocationId ?? null,
      JSON.stringify(n.correctionReasons ?? []),
      n.explanation ?? null,
      actor.id,
    ],
  );
  await appendAudit(c, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    eventType: 'REVISION_CREATED',
    subjectType: 'proposal_revision',
    subjectId: id,
    details: {
      caseId: n.caseId,
      origin: n.origin,
      digest: r.rows[0].digest,
      correctionReasons: n.correctionReasons ?? [],
    },
  });
  return toStoredRevision(r.rows[0]);
}

export async function insertRevision(pool: pg.Pool, actor: Actor, n: NewRevision): Promise<StoredRevision> {
  return withTx(pool, async (c) => {
    await getCaseForActor(c, actor, n.caseId, true);
    return insertRevisionTx(c, actor, n);
  });
}

export async function listRevisions(db: Queryable, actor: Actor, caseId: string): Promise<StoredRevision[]> {
  const r = await db.query(
    'select * from proposal_revisions where case_id = $1 and tenant_id = $2 order by revision_no',
    [caseId, actor.tenantId],
  );
  return r.rows.map(toStoredRevision);
}

export async function getRevisionForActor(db: Queryable, actor: Actor, revisionId: string, lock = false) {
  const r = await db.query(
    `select * from proposal_revisions where id = $1 and tenant_id = $2 ${lock ? 'for update' : ''}`,
    [revisionId, actor.tenantId],
  );
  return r.rows[0] ? toStoredRevision(r.rows[0]) : null;
}
