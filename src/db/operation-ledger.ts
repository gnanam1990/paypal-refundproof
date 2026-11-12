import type pg from 'pg';
import {
  deriveOperationIdentity,
  planAttempt,
  type ApprovedRevisionRef,
  type OperationIdentity,
  type ProviderAttemptPlan,
} from '../domain/identity';
import { OperationConflictError, type OperationLedger } from '../domain/ledger';
import { buildOutboundRefund } from '../domain/outbound';
import { correlationId, newId } from '../ids';
import { toStoredRevision } from '../services/revisions';
import { withTx } from './pool';

export class OperationPreconditionError extends Error {
  override readonly name = 'OperationPreconditionError';
}

const identityOf = (r: Record<string, unknown>): OperationIdentity => ({
  operationId: r.id as string,
  paypalRequestId: r.paypal_request_id as string,
  invoiceId: r.invoice_id as string,
  customId: r.custom_id as string,
});

/**
 * Durable OperationLedger. The approved revision row is locked, so concurrent callers serialize; the unique
 * approved_revision_id constraint is the final guard. The outbound request is frozen at creation.
 */
export class PgOperationLedger implements OperationLedger {
  constructor(
    private readonly pool: pg.Pool,
    private readonly actorId: string,
    private readonly onCreated?: (
      c: pg.PoolClient,
      identity: OperationIdentity,
      tenantId: string,
    ) => Promise<void>,
  ) {}

  ensureOperation(ref: ApprovedRevisionRef) {
    return withTx(this.pool, (c) => this.ensureOperationTx(c, ref));
  }

  async ensureOperationTx(
    c: pg.PoolClient,
    ref: ApprovedRevisionRef,
  ): Promise<{ identity: OperationIdentity; created: boolean }> {
    const rr = await c.query('select * from proposal_revisions where id = $1 for update', [ref.revisionId]);
    const row = rr.rows[0];
    if (!row) throw new OperationPreconditionError('revision not found');
    if (row.tenant_id !== ref.tenantId || row.digest !== ref.revisionDigest) {
      throw new OperationConflictError('revision id presented with a different tenant or digest');
    }
    const existing = await c.query('select * from refund_operations where approved_revision_id = $1', [
      ref.revisionId,
    ]);
    if (existing.rows[0]) return { identity: identityOf(existing.rows[0]), created: false };

    const rev = toStoredRevision(row); // re-verifies the stored digest against content
    if (rev.state !== 'APPROVED') throw new OperationPreconditionError('revision is not approved');
    const ap = await c.query(
      `select id from approvals where revision_id = $1 and decision = 'APPROVED' and revoked_at is null
          and expires_at > now() and revision_digest = $2`,
      [rev.id, rev.digest],
    );
    if (!ap.rows[0])
      throw new OperationPreconditionError('no active unexpired approval for this exact revision');

    const identity = deriveOperationIdentity(ref);
    const outbound = buildOutboundRefund(rev.content, identity);
    const ins = await c.query(
      `insert into refund_operations (id, tenant_id, case_id, approved_revision_id, approval_id, capture_id, paypal_request_id,
         invoice_id, custom_id, amount_kind, outbound_snapshot, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (approved_revision_id) do nothing returning *`,
      [
        identity.operationId,
        rev.tenantId,
        rev.caseId,
        rev.id,
        ap.rows[0].id,
        rev.content.captureId,
        identity.paypalRequestId,
        identity.invoiceId,
        identity.customId,
        rev.content.amount.kind,
        JSON.stringify(outbound),
        this.actorId,
      ],
    );
    if (!ins.rows[0]) {
      const again = await c.query('select * from refund_operations where approved_revision_id = $1', [
        ref.revisionId,
      ]);
      return { identity: identityOf(again.rows[0]), created: false };
    }
    await this.onCreated?.(c, identity, rev.tenantId);
    return { identity, created: true };
  }

  appendAttempt(operationId: string, phase: 'DISPATCHING' | 'NOT_SENT' = 'DISPATCHING') {
    return withTx(this.pool, (c) => appendAttemptTx(c, operationId, phase));
  }

  async listOperations(): Promise<OperationIdentity[]> {
    return (await this.pool.query('select * from refund_operations order by created_at')).rows.map(
      identityOf,
    );
  }

  async listAttempts(): Promise<ProviderAttemptPlan[]> {
    const r = await this.pool.query(
      'select operation_id, attempt_no, paypal_request_id from provider_attempts order by operation_id, attempt_no',
    );
    return r.rows.map((a) => ({
      operationId: a.operation_id,
      attemptNo: a.attempt_no,
      paypalRequestId: a.paypal_request_id,
    }));
  }
}

/** Allocates the next attempt under the operation's immutable request id. Locks the operation row. */
export async function appendAttemptTx(
  c: pg.PoolClient,
  operationId: string,
  phase: 'DISPATCHING' | 'NOT_SENT' = 'DISPATCHING',
  meta: { correlationId?: string; requestMeta?: unknown } = {},
): Promise<ProviderAttemptPlan & { attemptId: string; correlationId: string }> {
  const op = await c.query('select * from refund_operations where id = $1 for update', [operationId]);
  if (!op.rows[0]) throw new OperationPreconditionError('operation not found');
  const prior = await c.query('select count(*)::int as n from provider_attempts where operation_id = $1', [
    operationId,
  ]);
  const plan = planAttempt(identityOf(op.rows[0]), prior.rows[0].n);
  const attemptId = newId('att');
  const cid = meta.correlationId ?? correlationId();
  await c.query(
    `insert into provider_attempts (id, operation_id, paypal_request_id, attempt_no, phase, correlation_id, request_meta)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      attemptId,
      operationId,
      plan.paypalRequestId,
      plan.attemptNo,
      phase,
      cid,
      JSON.stringify(meta.requestMeta ?? {}),
    ],
  );
  return { ...plan, attemptId, correlationId: cid };
}
