import type pg from 'pg';
import type { Logger } from '../observability/log';
import { paypalFromEnv } from '../paypal/env';
import type { JobKind } from '../queue/outbox';
import { dispatchHandler, reconcileHandler } from '../services/execution';
import type { JobHandler } from './runner';
import { selftestHandler } from './selftest';

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

/**
 * Handler registry for the worker process. Refund dispatch and reconciliation run only when a PayPal sandbox
 * credential is configured; otherwise their jobs stay queued (BLOCKED_CREDENTIAL) and nothing is sent.
 */
export async function buildHandlers(deps: {
  pool: pg.Pool;
  log: Logger;
}): Promise<Partial<Record<JobKind, JobHandler>>> {
  const paypal = paypalFromEnv();
  if (!paypal) {
    deps.log.log('warn', 'worker.paypal_blocked', {
      reason: 'no PayPal sandbox credential (BLOCKED_CREDENTIAL)',
    });
    return { SELFTEST: selftestHandler };
  }
  const exec = {
    pool: deps.pool,
    paypal,
    reconcileDeadlineMs: int(process.env.REFUNDPROOF_RECONCILE_DEADLINE_MS, 24 * 3_600_000),
  };
  return {
    SELFTEST: selftestHandler,
    DISPATCH_REFUND: dispatchHandler(exec),
    RECONCILE_REFUND: reconcileHandler(exec),
  };
}
