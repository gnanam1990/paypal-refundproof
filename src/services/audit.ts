import type { Queryable } from '../db/pool';
import { scrub } from '../observability/log';

export interface AuditInput {
  tenantId: string | null;
  actorId: string | null;
  eventType: string;
  subjectType: string;
  subjectId: string;
  outcome?: 'OK' | 'DENIED' | 'ERROR';
  details?: Record<string, unknown>;
  correlationId?: string;
}

/** Append-only (enforced by trigger). Details are scrubbed: security events never store sensitive content. */
export async function appendAudit(db: Queryable, e: AuditInput) {
  await db.query(
    `insert into audit_events (tenant_id, actor_id, event_type, subject_type, subject_id, outcome, details, correlation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.tenantId,
      e.actorId,
      e.eventType,
      e.subjectType,
      e.subjectId,
      e.outcome ?? 'OK',
      JSON.stringify(scrub(e.details ?? {})),
      e.correlationId ?? null,
    ],
  );
}
