import type pg from 'pg';
import { z } from 'zod';
import { AppError, conflict, forbidden, requireRole, withDenialAudit, type Actor } from '../auth/actor';
import { withTx, type Queryable } from '../db/pool';
import { approvalDigest } from '../domain/identity';
import { formatMoney, type Money } from '../domain/money';
import type { RevisionContent } from '../domain/proposal';
import { newId } from '../ids';
import { appendAudit } from './audit';
import { getSnapshotForActor, type PublicSnapshot } from './captures';
import { getCaseForActor } from './cases';
import { getRevisionForActor, type StoredRevision } from './revisions';

export interface PolicyDefinition {
  approvalTtlMinutes: number;
  separationOfDuties: boolean;
  fullRefundRequiresConsent: boolean;
  adminRequiredAboveMinor: Record<string, number>;
}

const REFUNDABLE = new Set(['COMPLETED', 'PARTIALLY_REFUNDED']);

export async function loadPolicy(db: Queryable, version: string): Promise<PolicyDefinition> {
  const r = await db.query('select definition from approval_policies where version = $1', [version]);
  if (!r.rows[0]) throw new AppError(409, 'UNKNOWN_POLICY', `Approval policy ${version} is not defined`);
  return r.rows[0].definition as PolicyDefinition;
}

const moneyText = (m: Money) => `${formatMoney(m)} ${m.currency}`;

/** Which approver role the policy requires for this content. Unlisted currencies always need an ADMIN. */
export function requiredApproverRole(policy: PolicyDefinition, c: RevisionContent): 'APPROVER' | 'ADMIN' {
  if (c.amount.kind === 'FULL') {
    const limit = policy.adminRequiredAboveMinor[c.amount.captureAmount.currency];
    return limit === undefined || c.amount.captureAmount.minor > BigInt(limit) ? 'ADMIN' : 'APPROVER';
  }
  const limit = policy.adminRequiredAboveMinor[c.amount.amount.currency];
  return limit === undefined || c.amount.amount.minor > BigInt(limit) ? 'ADMIN' : 'APPROVER';
}

export interface ApprovalFacts {
  revisionId: string;
  revisionNo: number;
  caseId: string;
  state: string;
  effectiveState: string;
  revisionDigest: string;
  capture: PublicSnapshot | null;
  amount:
    | { kind: 'EXACT'; currency: string; value: string; display: string }
    | { kind: 'FULL'; currency: string; captureAmount: string; display: string };
  reason: { code: string; noteToPayer: string | null };
  evidenceDigests: readonly string[];
  policyVersion: string;
  policy: PolicyDefinition;
  requiredApproverRole: 'APPROVER' | 'ADMIN';
  origin: string;
  authoredBy: string;
  correctionReasons: string[];
  request: { id: string; requestedBy: string; requestedAt: string; note: string | null } | null;
  approval: {
    id: string;
    decision: string;
    approverId: string;
    decidedAt: string;
    expiresAt: string;
    revokedAt: string | null;
    fullRefundAcknowledged: boolean;
    approvalDigest: string;
    live: boolean;
  } | null;
}

/** The exact facts an approver decides on. Everything shown is derived from the stored, digest-checked row. */
export async function approvalFacts(db: Queryable, actor: Actor, revisionId: string): Promise<ApprovalFacts> {
  const rev = await getRevisionForActor(db, actor, revisionId);
  if (!rev)
    throw withDenialAudit(
      new AppError(404, 'NOT_FOUND', 'Revision not found'),
      actor,
      'revision',
      revisionId,
    );
  return factsFor(db, actor, rev);
}

async function factsFor(db: Queryable, actor: Actor, rev: StoredRevision): Promise<ApprovalFacts> {
  const policy = await loadPolicy(db, rev.content.policyVersion);
  const capture = rev.captureSnapshotId
    ? await getSnapshotForActor(db, actor, rev.caseId, rev.captureSnapshotId)
    : null;
  const req = await db.query('select * from approval_requests where revision_id = $1', [rev.id]);
  const ap = await db.query(
    `select * from approvals where revision_id = $1 order by decided_at desc limit 1`,
    [rev.id],
  );
  const a = ap.rows[0];
  const live = !!a && a.decision === 'APPROVED' && !a.revoked_at && new Date(a.expires_at) > new Date();
  const c = rev.content;
  return {
    revisionId: rev.id,
    revisionNo: rev.revisionNo,
    caseId: rev.caseId,
    state: rev.state,
    effectiveState: rev.state === 'APPROVED' && !live ? 'EXPIRED' : rev.state,
    revisionDigest: rev.digest,
    capture,
    amount:
      c.amount.kind === 'EXACT'
        ? {
            kind: 'EXACT',
            currency: c.amount.amount.currency,
            value: formatMoney(c.amount.amount),
            display: moneyText(c.amount.amount),
          }
        : {
            kind: 'FULL',
            currency: c.amount.captureAmount.currency,
            captureAmount: formatMoney(c.amount.captureAmount),
            display: `FULL remaining capture (captured ${moneyText(c.amount.captureAmount)})`,
          },
    reason: { code: c.reason.code, noteToPayer: c.reason.noteToPayer },
    evidenceDigests: c.evidenceDigests,
    policyVersion: c.policyVersion,
    policy,
    requiredApproverRole: requiredApproverRole(policy, c),
    origin: rev.origin,
    authoredBy: rev.authoredBy,
    correctionReasons: rev.correctionReasons,
    request: req.rows[0]
      ? {
          id: req.rows[0].id,
          requestedBy: req.rows[0].requested_by,
          requestedAt: new Date(req.rows[0].requested_at).toISOString(),
          note: req.rows[0].note,
        }
      : null,
    approval: a
      ? {
          id: a.id,
          decision: a.decision,
          approverId: a.approver_id,
          decidedAt: new Date(a.decided_at).toISOString(),
          expiresAt: new Date(a.expires_at).toISOString(),
          revokedAt: a.revoked_at ? new Date(a.revoked_at).toISOString() : null,
          fullRefundAcknowledged: a.full_refund_acknowledged,
          approvalDigest: a.approval_digest,
          live,
        }
      : null,
  };
}

async function lockRevision(c: pg.PoolClient, actor: Actor, revisionId: string): Promise<StoredRevision> {
  const peek = await getRevisionForActor(c, actor, revisionId);
  if (!peek)
    throw withDenialAudit(
      new AppError(404, 'NOT_FOUND', 'Revision not found'),
      actor,
      'revision',
      revisionId,
    );
  await getCaseForActor(c, actor, peek.caseId, true); // same lock order as drafting: case, then revision
  return (await getRevisionForActor(c, actor, revisionId, true))!;
}

const SubmitInput = z.strictObject({ note: z.string().trim().min(1).max(1000).optional() });

/** Operator asks for approval of a DRAFT with no outstanding correction. DRAFT -> REVIEWABLE + request. */
export async function submitForApproval(pool: pg.Pool, actor: Actor, revisionId: string, input: unknown) {
  requireRole(actor, 'OPERATOR', 'ADMIN');
  const v = SubmitInput.parse(input ?? {});
  return withTx(pool, async (c) => {
    const rev = await lockRevision(c, actor, revisionId);
    if (rev.state !== 'DRAFT')
      throw conflict('REVISION_NOT_DRAFT', `A ${rev.state} revision cannot be submitted`);
    if (rev.correctionReasons.length) {
      throw conflict('CORRECTION_REQUIRED', 'Resolve the correction reasons with a human revision first', {
        correctionReasons: rev.correctionReasons,
      });
    }
    if (!rev.captureSnapshotId) throw conflict('CAPTURE_REQUIRED', 'The revision has no capture snapshot');
    const snap = await getSnapshotForActor(c, actor, rev.caseId, rev.captureSnapshotId);
    if (!REFUNDABLE.has(snap.status)) throw conflict('CAPTURE_NOT_REFUNDABLE', `Capture is ${snap.status}`);
    if (snap.captureId !== rev.content.captureId)
      throw conflict('CAPTURE_MISMATCH', 'Snapshot and revision disagree');
    await loadPolicy(c, rev.content.policyVersion);
    await c.query(`update proposal_revisions set state = 'REVIEWABLE' where id = $1`, [rev.id]);
    const id = newId('areq');
    await c.query(
      `insert into approval_requests (id, tenant_id, case_id, revision_id, revision_digest, requested_by, note)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, actor.tenantId, rev.caseId, rev.id, rev.digest, actor.id, v.note ?? null],
    );
    await appendAudit(c, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      eventType: 'APPROVAL_REQUESTED',
      subjectType: 'proposal_revision',
      subjectId: rev.id,
      details: { caseId: rev.caseId, digest: rev.digest, requestId: id },
    });
    return factsFor(c, actor, { ...rev, state: 'REVIEWABLE' });
  });
}

const DecisionInput = z.strictObject({
  decision: z.enum(['APPROVED', 'REJECTED']),
  /** The digest of the facts the approver looked at; a different stored digest means the view was stale. */
  revisionDigest: z.string().regex(/^[0-9a-f]{64}$/),
  comment: z.string().trim().min(1).max(1000).optional(),
  /** Required for FULL: the approver re-states the captured amount they are refunding in full. */
  fullRefundConsent: z.strictObject({ captureAmount: z.string().min(1).max(40) }).optional(),
});

/** Approver decides the exact REVIEWABLE revision they viewed. */
export async function decideRevision(pool: pg.Pool, actor: Actor, revisionId: string, input: unknown) {
  requireRole(actor, 'APPROVER', 'ADMIN');
  const v = DecisionInput.parse(input);
  return withTx(pool, async (c) => {
    const rev = await lockRevision(c, actor, revisionId);
    if (rev.state !== 'REVIEWABLE') throw conflict('REVISION_NOT_REVIEWABLE', `The revision is ${rev.state}`);
    if (v.revisionDigest !== rev.digest) {
      throw conflict(
        'STALE_APPROVAL_VIEW',
        'The revision changed since it was viewed; review the current facts',
        {
          currentDigest: rev.digest,
        },
      );
    }
    const policy = await loadPolicy(c, rev.content.policyVersion);
    const req = (await c.query('select * from approval_requests where revision_id = $1', [rev.id])).rows[0];
    if (!req) throw conflict('NO_APPROVAL_REQUEST', 'Approval was not requested for this revision');
    if (policy.separationOfDuties && (actor.id === rev.authoredBy || actor.id === req.requested_by)) {
      throw withDenialAudit(
        forbidden('Separation of duties: you authored or requested this revision'),
        actor,
        'revision',
        rev.id,
        'SEPARATION_OF_DUTIES',
      );
    }
    let fullAck = false;
    if (v.decision === 'APPROVED') {
      const needed = requiredApproverRole(policy, rev.content);
      if (needed === 'ADMIN' && actor.role !== 'ADMIN') {
        throw withDenialAudit(
          forbidden('This amount requires an ADMIN approver under the policy'),
          actor,
          'revision',
          rev.id,
          'AMOUNT_LIMIT',
        );
      }
      if (rev.content.amount.kind === 'FULL') {
        const expected = formatMoney(rev.content.amount.captureAmount);
        if (!v.fullRefundConsent || v.fullRefundConsent.captureAmount.trim() !== expected) {
          throw new AppError(
            422,
            'FULL_REFUND_CONSENT_REQUIRED',
            `Confirm the full refund by re-stating the captured amount ${expected}`,
          );
        }
        fullAck = true;
      }
      if (rev.captureSnapshotId) {
        const snap = await getSnapshotForActor(c, actor, rev.caseId, rev.captureSnapshotId);
        if (!REFUNDABLE.has(snap.status))
          throw conflict('CAPTURE_NOT_REFUNDABLE', `Capture is ${snap.status}`);
      }
    }
    const decidedAt = new Date((await c.query('select now() as t')).rows[0].t);
    const expiresAt = new Date(decidedAt.getTime() + policy.approvalTtlMinutes * 60_000).toISOString();
    const id = newId('apr');
    const digest = approvalDigest({
      tenantId: actor.tenantId,
      revisionId: rev.id,
      revisionDigest: rev.digest,
      approverId: actor.id,
      policyVersion: rev.content.policyVersion,
      expiresAt,
    });
    await c.query(
      `insert into approvals (id, tenant_id, revision_id, revision_digest, approval_digest, approver_id, decision,
         policy_version, full_refund_acknowledged, decided_at, expires_at, comment, request_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        actor.tenantId,
        rev.id,
        rev.digest,
        digest,
        actor.id,
        v.decision,
        rev.content.policyVersion,
        fullAck,
        decidedAt.toISOString(),
        expiresAt,
        v.comment ?? null,
        req.id,
      ],
    );
    await c.query(`update proposal_revisions set state = $2 where id = $1`, [rev.id, v.decision]);
    await appendAudit(c, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      eventType: v.decision === 'APPROVED' ? 'REVISION_APPROVED' : 'REVISION_REJECTED',
      subjectType: 'proposal_revision',
      subjectId: rev.id,
      details: {
        caseId: rev.caseId,
        digest: rev.digest,
        approvalId: id,
        approvalDigest: digest,
        expiresAt,
        fullRefund: fullAck,
      },
    });
    return factsFor(c, actor, { ...rev, state: v.decision });
  });
}

const RevokeInput = z.strictObject({ reason: z.string().trim().min(1).max(1000) });

/** Revokes a live approval before execution; the revision becomes REJECTED (DB refuses once an operation exists). */
export async function revokeApproval(pool: pg.Pool, actor: Actor, approvalId: string, input: unknown) {
  requireRole(actor, 'APPROVER', 'ADMIN');
  const v = RevokeInput.parse(input);
  return withTx(pool, async (c) => {
    const a = (
      await c.query('select * from approvals where id = $1 and tenant_id = $2', [approvalId, actor.tenantId])
    ).rows[0];
    if (!a)
      throw withDenialAudit(
        new AppError(404, 'NOT_FOUND', 'Approval not found'),
        actor,
        'approval',
        approvalId,
      );
    const rev = await lockRevision(c, actor, a.revision_id);
    if (a.decision !== 'APPROVED' || a.revoked_at)
      throw conflict('APPROVAL_NOT_LIVE', 'Only a live approval can be revoked');
    const op = await c.query('select id from refund_operations where approved_revision_id = $1', [rev.id]);
    if (op.rowCount)
      throw conflict(
        'OPERATION_EXISTS',
        'An operation already exists for this approval; it cannot be revoked',
      );
    await c.query('update approvals set revoked_at = now(), revoked_by = $2 where id = $1', [a.id, actor.id]);
    await c.query(`update proposal_revisions set state = 'REJECTED' where id = $1`, [rev.id]);
    await appendAudit(c, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      eventType: 'APPROVAL_REVOKED',
      subjectType: 'approval',
      subjectId: a.id,
      details: { revisionId: rev.id, reason: v.reason },
    });
    return factsFor(c, actor, { ...rev, state: 'REJECTED' });
  });
}

/** Marks approved revisions whose approval lapsed (and that never got an operation) as EXPIRED. */
export async function expireLapsedApprovals(db: Queryable, tenantId: string) {
  await db.query(
    `update proposal_revisions r set state = 'EXPIRED'
      where r.tenant_id = $1 and r.state = 'APPROVED'
        and not exists (select 1 from refund_operations o where o.approved_revision_id = r.id)
        and not exists (select 1 from approvals a where a.revision_id = r.id and a.decision = 'APPROVED'
                          and a.revoked_at is null and a.expires_at > now())`,
    [tenantId],
  );
}

/** The approver queue: REVIEWABLE revisions of the tenant, oldest request first. */
export async function listPendingApprovals(db: Queryable, actor: Actor) {
  const r = await db.query(
    `select r.id, r.case_id, r.revision_no, r.digest, r.amount_kind, r.content, c.title, q.requested_by, q.requested_at
       from proposal_revisions r
       join cases c on c.id = r.case_id and c.tenant_id = r.tenant_id
       join approval_requests q on q.revision_id = r.id
      where r.tenant_id = $1 and r.state = 'REVIEWABLE'
      order by q.requested_at, r.id`,
    [actor.tenantId],
  );
  return r.rows.map((x) => ({
    revisionId: x.id,
    caseId: x.case_id,
    caseTitle: x.title,
    revisionNo: x.revision_no,
    digest: x.digest,
    amountKind: x.amount_kind,
    captureId: x.content.captureId,
    amount: x.content.amount,
    reasonCode: x.content.reason.code,
    requestedBy: x.requested_by,
    requestedAt: new Date(x.requested_at).toISOString(),
  }));
}
