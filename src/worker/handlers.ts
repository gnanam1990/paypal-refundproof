import type pg from 'pg';
import type { Logger } from '../observability/log';
import type { JobKind } from '../queue/outbox';
import type { JobHandler } from './runner';
import { selftestHandler } from './selftest';

/** Handler registry for the worker process. Refund dispatch and reconciliation register here (M04). */
export async function buildHandlers(_deps: {
  pool: pg.Pool;
  log: Logger;
}): Promise<Partial<Record<JobKind, JobHandler>>> {
  return { SELFTEST: selftestHandler };
}
