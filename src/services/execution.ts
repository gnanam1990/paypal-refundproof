import type pg from 'pg';
import { z } from 'zod';
import { AppError, conflict, requireRole, withDenialAudit, type Actor } from '../auth/actor';
import { PgOperationLedger } from '../db/operation-ledger';
import { appendAttemptTx } from '../db/operation-ledger';
import { withTx, type Queryable } from '../db/pool';
import type { OperationIdentity } from '../domain/identity';
import { assertOutboundMatches, OutboundMismatchError, type OutboundRefundRequest } from '../domain/outbound';
import { newId } from '../ids';
import { classifyLookup, classifyRefund, type ObservationClass } from '../paypal/classify';
import { PayPalUnavailableError, type PayPalClient, type RefundExchange } from '../paypal/client';
import { completeJob, enqueueJob, holdLease, LeaseLostError, rescheduleJob, type Job } from '../queue/outbox';
import type { JobHandler } from '../worker/runner';
import { appendAudit } from './audit';
import { getRevisionForActor, toStoredRevision } from './revisions';

/** Retryable "not processed" answers (401/429) get at most this many attempts before the outcome is reconciled. */
const MAX_RETRYABLE_ATTEMPTS = 5;
const RECONCILE_BASE_MS = 30_000;
const RECONCILE_MAX_MS = 60 * 60_000;

export interface ExecutionDeps {
  pool: pg.Pool;
  paypal: PayPalClient | null;
  reconcileDeadlineMs: number;
}

// ------------------------------------------------------------------------------------------------ request

/**
 * Creates the one operation for an approved revision (DB-enforced INV-01/INV-02) and schedules its dispatch in the
 * same transaction. The worker sends it; this request never calls PayPal.
 */
export async function requestExecution(deps: ExecutionDeps, actor: Actor, revisionId: string) {
  requireRole(actor, 'OPERATOR', 'ADMIN');
  const rev = await getRevisionForActor(deps.pool, actor, revisionId);
  if (!rev)
    throw withDenialAudit(
      new AppError(404, 'NOT_FOUND', 'Revision not found'),
      actor,
      'revision',
      revisionId,
    );
  if (!deps.paypal) {
    throw new AppError(
      503,
      'PAYPAL_BLOCKED',
      'No PayPal sandbox credential is configured (BLOCKED_CREDENTIAL)',
    );
  }
  if (rev.state !== 'APPROVED') throw conflict('REVISION_NOT_APPROVED', `The revision is ${rev.state}`);
  const snap = await deps.pool.query('select source from capture_snapshots where id = $1', [
    rev.captureSnapshotId,
  ]);
  if (snap.rows[0]?.source !== deps.paypal.label) {
    throw conflict(
      'CAPTURE_SOURCE_MISMATCH',
      `The capture was read from ${snap.rows[0]?.source ?? 'nowhere'}; execution uses ${deps.paypal.label}`,
    );
  }
  const ledger = new PgOperationLedger(deps.pool, actor.id, async (c, identity, tenantId) => {
    await enqueueJob(c, {
      kind: 'DISPATCH_REFUND',
      tenantId,
      operationId: identity.operationId,
      maxAttempts: 10,
    });
    await appendAudit(c, {
      tenantId,
      actorId: actor.id,
      eventType: 'OPERATION_CREATED',
      subjectType: 'refund_operation',
      subjectId: identity.operationId,
      details: { revisionId, paypalRequestId: identity.paypalRequestId },
    });
  });
  const { identity, created } = await ledger.ensureOperation({
    tenantId: actor.tenantId,
    revisionId: rev.id,
    revisionDigest: rev.digest,
  });
  return { operation: await getOperation(deps.pool, actor, identity.operationId), created };
}

// ------------------------------------------------------------------------------------------------ worker

async function loadOp(c: Queryable, id: string) {
  return (await c.query('select * from refund_operations where id = $1 for update', [id])).rows[0];
}

const identityOf = (op: Record<string, unknown>): OperationIdentity => ({
  operationId: op.id as string,
  paypalRequestId: op.paypal_request_id as string,
  invoiceId: op.invoice_id as string,
  customId: op.custom_id as string,
});

async function observe(
  c: Queryable,
  op: Record<string, unknown>,
  source: string,
  o: {
    kind: 'REFUND_RESPONSE' | 'REFUND_LOOKUP' | 'ORDER_LOOKUP' | 'ERROR_RESPONSE';
    classification: ObservationClass | 'MATCH_ABSENT';
    httpStatus?: number | null;
    debugId?: string | null;
    refundId?: string | null;
    refundStatus?: string | null;
    summary: Record<string, unknown>;
    correlationId: string;
  },
): Promise<string> {
  const id = newId('obs');
  await c.query(
    `insert into provider_observations (id, tenant_id, operation_id, capture_id, kind, classification, source, http_status,
       paypal_debug_id, refund_id, refund_status, summary, correlation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      op.tenant_id,
      op.id,
      op.capture_id,
      o.kind,
      o.classification,
      source,
      o.httpStatus ?? null,
      o.debugId ?? null,
      o.refundId ?? null,
      o.refundStatus ?? null,
      JSON.stringify(o.summary),
      o.correlationId,
    ],
  );
  return id;
}

async function scheduleReconcile(c: Queryable, op: Record<string, unknown>, delayMs = 0) {
  await enqueueJob(c, {
    kind: 'RECONCILE_REFUND',
    tenantId: op.tenant_id as string,
    operationId: op.id as string,
    runAt: new Date(Date.now() + delayMs),
    maxAttempts: 100,
  });
}

async function cancelBeforeDispatch(c: Queryable, op: Record<string, unknown>, reason: string) {
  await c.query(
    `update refund_operations set state = 'CANCELLED_BEFORE_DISPATCH', never_dispatched_evidence = $2 where id = $1`,
    [op.id, JSON.stringify({ reason, at: new Date().toISOString(), attempts: 0 })],
  );
  await appendAudit(c, {
    tenantId: op.tenant_id as string,
    actorId: null,
    eventType: 'OPERATION_CANCELLED_BEFORE_DISPATCH',
    subjectType: 'refund_operation',
    subjectId: op.id as string,
    details: { reason },
  });
}

/** DISPATCH_REFUND: preflight, durable attempt, one network request outside any transaction, recorded outcome. */
export function dispatchHandler(deps: ExecutionDeps): JobHandler {
  return async (job: Job, h) => {
    const paypal = deps.paypal;
    if (!paypal) throw new PayPalUnavailableError('PayPal is not configured (BLOCKED_CREDENTIAL)');
    await paypal.prepare(); // obtain a token before any attempt is recorded: a token failure sends nothing

    const begin = await withTx(deps.pool, async (c) => {
      await holdLease(c, job, h.workerId);
      const op = await loadOp(c, job.operationId!);
      if (op.state === 'SUBMITTING') {
        const last = (
          await c.query(
            'select * from provider_attempts where operation_id = $1 order by attempt_no desc limit 1',
            [op.id],
          )
        ).rows[0];
        const retryable = last?.phase === 'RESPONDED' && [401, 429].includes(last.http_status);
        if (!retryable) {
          // A previous run began dispatch and never recorded an answer: the request may have reached PayPal.
          if (last?.phase === 'DISPATCHING') {
            await c.query(
              `update provider_attempts set phase = 'LOST', finished_at = clock_timestamp(), error_class = 'WORKER_INTERRUPTED' where id = $1`,
              [last.id],
            );
          }
          await c.query(`update refund_operations set state = 'OUTCOME_UNKNOWN' where id = $1`, [op.id]);
          await scheduleReconcile(c, op);
          await completeJob(c, job, h.workerId);
          return null;
        }
        if (last.attempt_no >= MAX_RETRYABLE_ATTEMPTS) {
          await c.query(`update refund_operations set state = 'OUTCOME_UNKNOWN' where id = $1`, [op.id]);
          await scheduleReconcile(c, op);
          await completeJob(c, job, h.workerId);
          return null;
        }
      } else if (op.state === 'READY') {
        const revRow = (
          await c.query('select * from proposal_revisions where id = $1', [op.approved_revision_id])
        ).rows[0];
        const rev = toStoredRevision(revRow);
        const live = await c.query(
          `select 1 from approvals where id = $1 and decision = 'APPROVED' and revoked_at is null and expires_at > now()`,
          [op.approval_id],
        );
        const snap = (
          await c.query('select source from capture_snapshots where id = $1', [rev.captureSnapshotId])
        ).rows[0];
        let refusal: string | null = null;
        if (rev.state !== 'APPROVED' || !live.rowCount) refusal = 'APPROVAL_NOT_LIVE';
        else if (snap?.source !== paypal.label) refusal = 'CAPTURE_SOURCE_MISMATCH';
        else {
          try {
            assertOutboundMatches(op.outbound_snapshot as OutboundRefundRequest, rev.content, identityOf(op));
          } catch (e) {
            if (!(e instanceof OutboundMismatchError)) throw e;
            refusal = 'OUTBOUND_MISMATCH';
          }
        }
        if (refusal) {
          await cancelBeforeDispatch(c, op, refusal);
          await completeJob(c, job, h.workerId);
          return null;
        }
        await c.query(`update refund_operations set state = 'SUBMITTING' where id = $1`, [op.id]);
      } else {
        await completeJob(c, job, h.workerId); // already past dispatch
        return null;
      }
      const outbound = op.outbound_snapshot as OutboundRefundRequest;
      const attempt = await appendAttemptTx(c, op.id, 'DISPATCHING', {
        requestMeta: {
          semantic: outbound.semantic,
          expected: outbound.expected,
          sendsAmount: !!outbound.body.amount,
        },
      });
      return { op, outbound, attempt };
    });
    if (!begin) return 'COMPLETED_IN_TX';
    if (h.signal.aborted) throw new LeaseLostError('lease lost before sending');

    const exchange: RefundExchange = await paypal.refund(begin.outbound);
    const cls = classifyRefund(exchange);

    return withTx(deps.pool, async (c) => {
      await holdLease(c, job, h.workerId);
      const op = await loadOp(c, begin.op.id);
      const answered = exchange.kind === 'ANSWERED';
      const obsId = await observe(c, op, paypal.label, {
        kind: answered && exchange.httpStatus < 300 ? 'REFUND_RESPONSE' : 'ERROR_RESPONSE',
        classification: cls.classification,
        httpStatus: answered ? exchange.httpStatus : null,
        debugId: answered ? exchange.debugId : null,
        refundId: cls.refundId,
        refundStatus: cls.refundStatus,
        summary: {
          errorClass: answered ? null : exchange.errorClass,
          name: answered ? ((exchange.body as { name?: string } | null)?.name ?? null) : null,
        },
        correlationId: begin.attempt.correlationId,
      });
      if (answered) {
        await c.query(
          `update provider_attempts set phase = 'RESPONDED', finished_at = clock_timestamp(), http_status = $2,
             response_meta = $3 where id = $1`,
          [
            begin.attempt.attemptId,
            exchange.httpStatus,
            JSON.stringify({ debugId: exchange.debugId, refundId: cls.refundId, status: cls.refundStatus }),
          ],
        );
      } else {
        await c.query(
          `update provider_attempts set phase = 'LOST', finished_at = clock_timestamp(), error_class = $2 where id = $1`,
          [begin.attempt.attemptId, exchange.errorClass.slice(0, 100)],
        );
      }
      switch (cls.classification) {
        case 'REFUND_COMPLETED':
          await c.query(
            `update refund_operations set state = 'CONFIRMED', confirmed_observation_id = $2, refund_id = $3 where id = $1`,
            [op.id, obsId, cls.refundId],
          );
          break;
        case 'REFUND_PENDING':
          await c.query(
            `update refund_operations set state = 'RECONCILING', refund_id = $2, reconcile_started_at = now() where id = $1`,
            [op.id, cls.refundId],
          );
          await scheduleReconcile(c, op, RECONCILE_BASE_MS);
          break;
        case 'REFUND_TERMINAL_NOT_APPLIED':
        case 'REQUEST_REJECTED_TERMINAL':
          await c.query(
            `update refund_operations set state = 'PROVIDER_TERMINAL_NOT_APPLIED', terminal_observation_id = $2, refund_id = coalesce(refund_id, $3) where id = $1`,
            [op.id, obsId, cls.refundId],
          );
          break;
        case 'NOT_PROCESSED_RETRYABLE':
          await rescheduleJob(c, job, h.workerId, new Date(Date.now() + 5_000 * begin.attempt.attemptNo));
          return 'RESCHEDULED' as const;
        default:
          await c.query(`update refund_operations set state = 'OUTCOME_UNKNOWN' where id = $1`, [op.id]);
          await scheduleReconcile(c, op);
      }
      await completeJob(c, job, h.workerId);
      return 'COMPLETED_IN_TX' as const;
    });
  };
}

/** RECONCILE_REFUND: authoritative lookup by the operation's own identifiers; absence is never terminal. */
export function reconcileHandler(deps: ExecutionDeps): JobHandler {
  return async (job: Job, h) => {
    const paypal = deps.paypal;
    if (!paypal) throw new PayPalUnavailableError('PayPal is not configured (BLOCKED_CREDENTIAL)');
    const begin = await withTx(deps.pool, async (c) => {
      await holdLease(c, job, h.workerId);
      const op = await loadOp(c, job.operationId!);
      if (op.state === 'OUTCOME_UNKNOWN') {
        await c.query(
          `update refund_operations set state = 'RECONCILING', reconcile_started_at = now() where id = $1`,
          [op.id],
        );
        op.state = 'RECONCILING';
        op.reconcile_started_at = new Date();
      }
      if (op.state !== 'RECONCILING') {
        await completeJob(c, job, h.workerId);
        return null;
      }
      const snap = (
        await c.query(
          `select s.order_id from proposal_revisions r join capture_snapshots s on s.id = r.capture_snapshot_id where r.id = $1`,
          [op.approved_revision_id],
        )
      ).rows[0];
      const lookups = (
        await c.query(
          `select count(*)::int n from provider_observations where operation_id = $1 and kind in ('REFUND_LOOKUP', 'ORDER_LOOKUP')`,
          [op.id],
        )
      ).rows[0].n as number;
      return { op, orderId: (snap?.order_id as string | null) ?? null, lookups };
    });
    if (!begin) return 'COMPLETED_IN_TX';
    const { op } = begin;
    const cid = newId('cor');

    let found: {
      classification: ObservationClass | 'MATCH_ABSENT';
      refundId: string | null;
      status: string | null;
    };
    let meta: {
      kind: 'REFUND_LOOKUP' | 'ORDER_LOOKUP' | 'ERROR_RESPONSE';
      httpStatus: number | null;
      debugId: string | null;
      note: string;
    };
    try {
      if (op.refund_id) {
        const r = await paypal.getRefund(op.refund_id);
        const status = r.status === 200 ? String(r.body?.status ?? '') || null : null;
        found = {
          classification: r.status === 200 ? classifyLookup(status) : 'AMBIGUOUS',
          refundId: op.refund_id,
          status,
        };
        meta = { kind: 'REFUND_LOOKUP', httpStatus: r.status, debugId: r.debugId, note: 'refund by id' };
      } else if (begin.orderId) {
        const r = await paypal.orderRefunds(begin.orderId);
        const match =
          r.refunds.find((x) => x.invoiceId === op.invoice_id && x.customId === op.custom_id) ?? null;
        found = {
          classification: r.status === 200 ? classifyLookup(match?.status ?? null) : 'AMBIGUOUS',
          refundId: match?.id ?? null,
          status: match?.status ?? null,
        };
        meta = {
          kind: 'ORDER_LOOKUP',
          httpStatus: r.status,
          debugId: r.debugId,
          note: 'order refunds by invoice_id/custom_id',
        };
      } else {
        found = { classification: 'AMBIGUOUS', refundId: null, status: null };
        meta = {
          kind: 'ERROR_RESPONSE',
          httpStatus: null,
          debugId: null,
          note: 'capture snapshot has no order id',
        };
      }
    } catch (e) {
      found = { classification: 'AMBIGUOUS', refundId: null, status: null };
      meta = {
        kind: 'ERROR_RESPONSE',
        httpStatus: null,
        debugId: null,
        note: e instanceof Error ? e.name : 'lookup failed',
      };
    }

    return withTx(deps.pool, async (c) => {
      await holdLease(c, job, h.workerId);
      const cur = await loadOp(c, op.id);
      if (cur.state !== 'RECONCILING') {
        await completeJob(c, job, h.workerId);
        return 'COMPLETED_IN_TX' as const;
      }
      const obsId = await observe(c, cur, paypal.label, {
        kind: meta.kind,
        classification: found.classification,
        httpStatus: meta.httpStatus,
        debugId: meta.debugId,
        refundId: found.refundId,
        refundStatus: found.status,
        summary: { lookup: meta.note },
        correlationId: cid,
      });
      if (found.classification === 'REFUND_COMPLETED') {
        await c.query(
          `update refund_operations set state = 'CONFIRMED', confirmed_observation_id = $2, refund_id = coalesce(refund_id, $3), next_reconcile_at = null where id = $1`,
          [cur.id, obsId, found.refundId],
        );
      } else if (found.classification === 'REFUND_TERMINAL_NOT_APPLIED') {
        await c.query(
          `update refund_operations set state = 'PROVIDER_TERMINAL_NOT_APPLIED', terminal_observation_id = $2, refund_id = coalesce(refund_id, $3), next_reconcile_at = null where id = $1`,
          [cur.id, obsId, found.refundId],
        );
      } else {
        // PENDING, absent or ambiguous: not terminal. Back off until the reconciliation deadline, then EXHAUSTED.
        if (found.refundId && !cur.refund_id) {
          await c.query('update refund_operations set refund_id = $2 where id = $1', [
            cur.id,
            found.refundId,
          ]);
        }
        const started = new Date(cur.reconcile_started_at ?? cur.updated_at).getTime();
        if (Date.now() - started > deps.reconcileDeadlineMs) {
          await c.query(
            `update refund_operations set state = 'EXHAUSTED', next_reconcile_at = null where id = $1`,
            [cur.id],
          );
          await appendAudit(c, {
            tenantId: cur.tenant_id,
            actorId: null,
            eventType: 'RECONCILIATION_EXHAUSTED',
            subjectType: 'refund_operation',
            subjectId: cur.id,
            details: { lookups: begin.lookups + 1, last: found.classification },
          });
        } else {
          const delay = Math.min(RECONCILE_BASE_MS * 2 ** begin.lookups, RECONCILE_MAX_MS);
          const next = new Date(Date.now() + delay);
          await c.query('update refund_operations set next_reconcile_at = $2 where id = $1', [cur.id, next]);
          await rescheduleJob(c, job, h.workerId, next);
          return 'RESCHEDULED' as const;
        }
      }
      await completeJob(c, job, h.workerId);
      return 'COMPLETED_IN_TX' as const;
    });
  };
}

// ------------------------------------------------------------------------------------------------ read & recovery

export async function listOperations(db: Queryable, actor: Actor, caseId: string) {
  const r = await db.query(
    `select id, approved_revision_id, state, paypal_request_id, refund_id, amount_kind, created_at, updated_at, next_reconcile_at, escalated_at
       from refund_operations where case_id = $1 and tenant_id = $2 order by created_at`,
    [caseId, actor.tenantId],
  );
  return r.rows.map((o) => ({
    id: o.id,
    revisionId: o.approved_revision_id,
    state: o.state,
    paypalRequestId: o.paypal_request_id,
    refundId: o.refund_id,
    amountKind: o.amount_kind,
    createdAt: new Date(o.created_at).toISOString(),
    updatedAt: new Date(o.updated_at).toISOString(),
    nextReconcileAt: o.next_reconcile_at ? new Date(o.next_reconcile_at).toISOString() : null,
    escalatedAt: o.escalated_at ? new Date(o.escalated_at).toISOString() : null,
  }));
}

export async function getOperation(db: Queryable, actor: Actor, operationId: string) {
  const o = (
    await db.query('select * from refund_operations where id = $1 and tenant_id = $2', [
      operationId,
      actor.tenantId,
    ])
  ).rows[0];
  if (!o)
    throw withDenialAudit(
      new AppError(404, 'NOT_FOUND', 'Operation not found'),
      actor,
      'refund_operation',
      operationId,
    );
  const [attempts, observations, transitions, jobs] = await Promise.all([
    db.query(
      'select attempt_no, phase, started_at, finished_at, http_status, error_class, correlation_id from provider_attempts where operation_id = $1 order by attempt_no',
      [o.id],
    ),
    db.query(
      'select id, kind, classification, source, http_status, paypal_debug_id, refund_id, refund_status, observed_at, summary from provider_observations where operation_id = $1 order by observed_at, id',
      [o.id],
    ),
    db.query(
      `select from_state, to_state, created_at from state_transitions where subject_id = $1 and machine = 'operation' order by id`,
      [o.id],
    ),
    db.query(
      'select id, kind, state, attempts, run_at, last_error from outbox_jobs where operation_id = $1 order by id',
      [o.id],
    ),
  ]);
  return {
    id: o.id,
    caseId: o.case_id,
    revisionId: o.approved_revision_id,
    approvalId: o.approval_id,
    state: o.state,
    captureId: o.capture_id,
    paypalRequestId: o.paypal_request_id,
    invoiceId: o.invoice_id,
    customId: o.custom_id,
    refundId: o.refund_id,
    outbound: o.outbound_snapshot,
    neverDispatchedEvidence: o.never_dispatched_evidence,
    confirmedObservationId: o.confirmed_observation_id,
    terminalObservationId: o.terminal_observation_id,
    nextReconcileAt: o.next_reconcile_at ? new Date(o.next_reconcile_at).toISOString() : null,
    escalation: o.escalated_at
      ? { at: new Date(o.escalated_at).toISOString(), by: o.escalated_by, note: o.escalation_note }
      : null,
    createdAt: new Date(o.created_at).toISOString(),
    attempts: attempts.rows,
    observations: observations.rows,
    transitions: transitions.rows,
    jobs: jobs.rows,
  };
}

/** EXHAUSTED -> RECONCILING with a fresh deadline: an operator asks for more lookups. Never a new dispatch. */
export async function resumeReconciliation(pool: pg.Pool, actor: Actor, operationId: string) {
  requireRole(actor, 'OPERATOR', 'ADMIN');
  return withTx(pool, async (c) => {
    const o = (
      await c.query('select * from refund_operations where id = $1 and tenant_id = $2 for update', [
        operationId,
        actor.tenantId,
      ])
    ).rows[0];
    if (!o)
      throw withDenialAudit(
        new AppError(404, 'NOT_FOUND', 'Operation not found'),
        actor,
        'refund_operation',
        operationId,
      );
    if (o.state !== 'EXHAUSTED')
      throw conflict('NOT_EXHAUSTED', `Reconciliation can be resumed only from EXHAUSTED (is ${o.state})`);
    await c.query(
      `update refund_operations set state = 'RECONCILING', reconcile_started_at = now() where id = $1`,
      [o.id],
    );
    await scheduleReconcile(c, o);
    await appendAudit(c, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      eventType: 'RECONCILIATION_RESUMED',
      subjectType: 'refund_operation',
      subjectId: o.id,
    });
    return { ok: true };
  });
}

const EscalateInput = z.strictObject({ note: z.string().trim().min(1).max(2000) });

/** Records an escalation on an unresolved operation. It changes no provider state. */
export async function escalateOperation(pool: pg.Pool, actor: Actor, operationId: string, input: unknown) {
  const v = EscalateInput.parse(input);
  return withTx(pool, async (c) => {
    const o = (
      await c.query('select * from refund_operations where id = $1 and tenant_id = $2 for update', [
        operationId,
        actor.tenantId,
      ])
    ).rows[0];
    if (!o)
      throw withDenialAudit(
        new AppError(404, 'NOT_FOUND', 'Operation not found'),
        actor,
        'refund_operation',
        operationId,
      );
    if (!['OUTCOME_UNKNOWN', 'RECONCILING', 'EXHAUSTED'].includes(o.state)) {
      throw conflict('NOT_UNRESOLVED', `Only unresolved operations are escalated (is ${o.state})`);
    }
    await c.query(
      'update refund_operations set escalated_at = now(), escalated_by = $2, escalation_note = $3 where id = $1',
      [o.id, actor.id, v.note],
    );
    await appendAudit(c, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      eventType: 'OPERATION_ESCALATED',
      subjectType: 'refund_operation',
      subjectId: o.id,
    });
    return { ok: true };
  });
}
