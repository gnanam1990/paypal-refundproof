import { ZodError } from 'zod';
import { AppError } from '../auth/actor';
import type { Queryable } from '../db/pool';
import { correlationId } from '../ids';
import { rootLogger } from '../observability/log';
import { appendAudit } from '../services/audit';

const SECURITY_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    {
      status,
      headers: { ...SECURITY_HEADERS, ...headers },
    },
  );
}

/** Maps errors to honest, non-leaking responses and persists security denials outside any rolled-back tx. */
export async function errorResponse(e: unknown, db: Queryable): Promise<Response> {
  if (e instanceof AppError) {
    if (e.denial) {
      await appendAudit(db, {
        tenantId: e.denial.tenantId,
        actorId: e.denial.actorId,
        eventType: 'ACCESS_DENIED',
        subjectType: e.denial.subjectType,
        subjectId: e.denial.subjectId,
        outcome: 'DENIED',
        details: { reason: e.denial.reason, status: e.status },
      }).catch(() => undefined);
    }
    return json(e.status, { error: { code: e.code, message: e.message, details: e.details } });
  }
  if (e instanceof ZodError) {
    return json(422, {
      error: {
        code: 'VALIDATION',
        message: 'Request failed validation',
        issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      },
    });
  }
  const pgCode = (e as { code?: string })?.code;
  if (pgCode === '23505')
    return json(409, { error: { code: 'CONFLICT', message: 'A conflicting record already exists' } });
  if (pgCode === '23514' || pgCode === '55000') {
    return json(409, {
      error: { code: 'INVARIANT', message: 'The request would violate a safety invariant' },
    });
  }
  const cid = correlationId();
  rootLogger.log('error', 'http.unhandled', {
    correlationId: cid,
    error: e instanceof Error ? e.message : String(e),
  });
  return json(500, { error: { code: 'INTERNAL', message: 'Internal error', correlationId: cid } });
}
