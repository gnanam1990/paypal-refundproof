import type pg from 'pg';
import { z } from 'zod';
import { notFound, requireRole, withDenialAudit, type Actor } from '../auth/actor';
import { withTx, type Queryable } from '../db/pool';
import { newId } from '../ids';
import { appendAudit } from './audit';

export const CreateCaseInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  customerRef: z.string().trim().min(1).max(200).optional(),
});

export interface CaseRow {
  id: string;
  tenantId: string;
  title: string;
  customerRef: string | null;
  status: 'OPEN' | 'RESOLVED' | 'ESCALATED';
  createdBy: string;
  createdAt: string;
}

const toCase = (r: Record<string, unknown>): CaseRow => ({
  id: r.id as string,
  tenantId: r.tenant_id as string,
  title: r.title as string,
  customerRef: (r.customer_ref as string | null) ?? null,
  status: r.status as CaseRow['status'],
  createdBy: r.created_by as string,
  createdAt: new Date(r.created_at as string).toISOString(),
});

export async function createCase(pool: pg.Pool, actor: Actor, input: unknown): Promise<CaseRow> {
  requireRole(actor, 'OPERATOR', 'ADMIN');
  const v = CreateCaseInput.parse(input);
  return withTx(pool, async (c) => {
    const id = newId('case');
    const r = await c.query(
      `insert into cases (id, tenant_id, title, customer_ref, created_by) values ($1, $2, $3, $4, $5) returning *`,
      [id, actor.tenantId, v.title, v.customerRef ?? null, actor.id],
    );
    await appendAudit(c, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      eventType: 'CASE_CREATED',
      subjectType: 'case',
      subjectId: id,
      details: { caseId: id },
    });
    return toCase(r.rows[0]);
  });
}

/** Tenant-scoped lookup. A case in another tenant is indistinguishable from a missing one, and is audited. */
export async function getCaseForActor(
  db: Queryable,
  actor: Actor,
  caseId: string,
  lock = false,
): Promise<CaseRow> {
  const r = await db.query(
    `select * from cases where id = $1 and tenant_id = $2 ${lock ? 'for update' : ''}`,
    [caseId, actor.tenantId],
  );
  if (!r.rows[0]) {
    // The denial is persisted by the request boundary, outside any transaction this lookup may roll back.
    throw withDenialAudit(notFound('Case'), actor, 'case', caseId);
  }
  return toCase(r.rows[0]);
}

export async function listCases(db: Queryable, actor: Actor) {
  const r = await db.query(
    `select c.*,
            (select state from proposal_revisions p where p.case_id = c.id order by revision_no desc limit 1) as proposal_state,
            (select state from refund_operations o where o.case_id = c.id order by created_at desc limit 1) as operation_state
       from cases c where c.tenant_id = $1 order by c.created_at desc limit 200`,
    [actor.tenantId],
  );
  return r.rows.map((row) => ({
    ...toCase(row),
    proposalState: (row.proposal_state as string | null) ?? null,
    operationState: (row.operation_state as string | null) ?? null,
  }));
}

export async function caseAuditTrail(db: Queryable, actor: Actor, caseId: string) {
  await getCaseForActor(db, actor, caseId);
  const r = await db.query(
    `select id, actor_id, event_type, subject_type, subject_id, outcome, details, correlation_id, created_at
       from audit_events
      where tenant_id = $1 and (subject_id = $2 or details->>'caseId' = $2)
      order by id`,
    [actor.tenantId, caseId],
  );
  const t = await db.query(
    `select st.machine, st.subject_id, st.from_state, st.to_state, st.created_at
       from state_transitions st
      where st.tenant_id = $1 and st.subject_id in (
        select id from proposal_revisions where case_id = $2
        union all select id from refund_operations where case_id = $2)
      order by st.id`,
    [actor.tenantId, caseId],
  );
  return {
    events: r.rows.map((e) => ({
      id: Number(e.id),
      actorId: e.actor_id,
      eventType: e.event_type,
      subjectType: e.subject_type,
      subjectId: e.subject_id,
      outcome: e.outcome,
      details: e.details,
      correlationId: e.correlation_id,
      createdAt: new Date(e.created_at).toISOString(),
    })),
    transitions: t.rows.map((x) => ({
      machine: x.machine,
      subjectId: x.subject_id,
      from: x.from_state,
      to: x.to_state,
      at: new Date(x.created_at).toISOString(),
    })),
  };
}
