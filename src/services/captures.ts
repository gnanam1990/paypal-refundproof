import type pg from 'pg';
import { z } from 'zod';
import { AppError, requireRole, type Actor } from '../auth/actor';
import { withTx, type Queryable } from '../db/pool';
import { formatMoney, money, parseMoney, type Money } from '../domain/money';
import { newId } from '../ids';
import { appendAudit } from './audit';
import { getCaseForActor } from './cases';

/** What a capture lookup returns: only the declared fields RefundProof uses. */
export interface CaptureFacts {
  captureId: string;
  status: string;
  amount: Money;
  orderId: string | null;
  payeeMerchantId: string | null;
  invoiceId: string | null;
}

export type CaptureSourceLabel = 'PAYPAL_SANDBOX' | 'CONTRACT_STUB';

/**
 * The capture retrieval boundary. `PAYPAL_SANDBOX` is the real adapter (src/paypal); `CONTRACT_STUB` serves
 * labelled sandbox-shaped fixtures for local development only. Every stored snapshot records which one answered.
 */
export interface CaptureSource {
  readonly label: CaptureSourceLabel;
  getCapture(captureId: string): Promise<CaptureFacts | null>;
}

export class CaptureUnavailableError extends Error {
  override readonly name = 'CaptureUnavailableError';
}

const StubFile = z.array(
  z.strictObject({
    captureId: z.string().min(1).max(64),
    status: z.string(),
    currency: z.string(),
    value: z.string(),
    orderId: z.string().nullable(),
    payeeMerchantId: z.string().nullable(),
  }),
);

/** Labelled contract-stub captures (fixtures/contract-stub-captures.json). Never used in production. */
export class ContractStubCaptureSource implements CaptureSource {
  readonly label = 'CONTRACT_STUB' as const;
  private readonly rows: Map<string, CaptureFacts>;
  constructor(fixtures: unknown) {
    this.rows = new Map(
      StubFile.parse(fixtures).map((r) => [
        r.captureId,
        {
          captureId: r.captureId,
          status: r.status,
          amount: parseMoney(r.value, r.currency),
          orderId: r.orderId,
          payeeMerchantId: r.payeeMerchantId,
          invoiceId: null,
        },
      ]),
    );
  }
  async getCapture(captureId: string) {
    return this.rows.get(captureId) ?? null;
  }
}

export interface PublicSnapshot {
  id: string;
  caseId: string;
  captureId: string;
  status: string;
  amount: { currency: string; value: string };
  orderId: string | null;
  payeeMerchantId: string | null;
  source: CaptureSourceLabel;
  fetchedAt: string;
  fetchedBy: string;
}

export const toSnapshot = (r: Record<string, unknown>): PublicSnapshot => ({
  id: r.id as string,
  caseId: r.case_id as string,
  captureId: r.capture_id as string,
  status: r.status as string,
  amount: {
    currency: r.currency as string,
    value: formatMoney(money(r.currency as never, BigInt(r.amount_minor as string))),
  },
  orderId: (r.order_id as string | null) ?? null,
  payeeMerchantId: (r.payee_merchant_id as string | null) ?? null,
  source: r.source as CaptureSourceLabel,
  fetchedAt: new Date(r.fetched_at as string).toISOString(),
  fetchedBy: r.fetched_by as string,
});

export const snapshotMoney = (s: PublicSnapshot): Money => parseMoney(s.amount.value, s.amount.currency);

const FetchInput = z.strictObject({
  captureId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/),
});

/** Looks the capture up through the configured source and stores an immutable snapshot on the case. */
export async function fetchCaptureSnapshot(
  pool: pg.Pool,
  source: CaptureSource | null,
  actor: Actor,
  caseId: string,
  input: unknown,
): Promise<PublicSnapshot> {
  requireRole(actor, 'OPERATOR', 'ADMIN');
  const { captureId } = FetchInput.parse(input);
  await getCaseForActor(pool, actor, caseId);
  if (!source) {
    throw new AppError(503, 'CAPTURE_SOURCE_BLOCKED', 'No capture source is configured (BLOCKED_CREDENTIAL)');
  }
  const facts = await source.getCapture(captureId);
  if (!facts) throw new AppError(404, 'CAPTURE_NOT_FOUND', 'The capture source has no such capture');
  return withTx(pool, async (c) => {
    await getCaseForActor(c, actor, caseId, true);
    const id = newId('cap');
    const r = await c.query(
      `insert into capture_snapshots (id, tenant_id, case_id, capture_id, status, amount_minor, currency, order_id,
         payee_merchant_id, source, summary, fetched_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [
        id,
        actor.tenantId,
        caseId,
        facts.captureId,
        facts.status,
        facts.amount.minor.toString(),
        facts.amount.currency,
        facts.orderId,
        facts.payeeMerchantId,
        source.label,
        JSON.stringify({ invoiceId: facts.invoiceId }),
        actor.id,
      ],
    );
    await appendAudit(c, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      eventType: 'CAPTURE_SNAPSHOT_FETCHED',
      subjectType: 'capture_snapshot',
      subjectId: id,
      details: { caseId, captureId: facts.captureId, status: facts.status, source: source.label },
    });
    return toSnapshot(r.rows[0]);
  });
}

export async function listSnapshots(db: Queryable, actor: Actor, caseId: string) {
  const r = await db.query(
    'select * from capture_snapshots where case_id = $1 and tenant_id = $2 order by fetched_at desc, id',
    [caseId, actor.tenantId],
  );
  return r.rows.map(toSnapshot);
}

export async function getSnapshotForActor(db: Queryable, actor: Actor, caseId: string, snapshotId: string) {
  const r = await db.query(
    'select * from capture_snapshots where id = $1 and case_id = $2 and tenant_id = $3',
    [snapshotId, caseId, actor.tenantId],
  );
  if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Capture snapshot not found');
  return toSnapshot(r.rows[0]);
}
