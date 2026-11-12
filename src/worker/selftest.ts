import { withTx } from '../db/pool';
import { LeaseLostError } from '../queue/outbox';
import { appendAudit } from '../services/audit';
import type { JobHandler } from './runner';

/**
 * End-to-end liveness probe for the durable queue (used by health checks and restart tests). Its single
 * effect (an audit row) commits in the same transaction as job completion, so it happens at most once.
 */
export const selftestHandler: JobHandler = async (job, ctx) => {
  const sleepMs = Math.min(Math.max(Number(job.payload.sleepMs ?? 0), 0), 30_000);
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, sleepMs);
    ctx.signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
  if (ctx.signal.aborted) throw new LeaseLostError('lease lost during selftest');
  await withTx(ctx.pool, async (c) => {
    const r = await c.query(
      `update outbox_jobs set state = 'DONE', lease_expires_at = null, updated_at = now()
        where id = $1 and lease_owner = $2 and state = 'RUNNING'`,
      [job.id, ctx.workerId],
    );
    if (r.rowCount !== 1) throw new LeaseLostError('lease lost before completing selftest');
    await appendAudit(c, {
      tenantId: job.tenantId,
      actorId: null,
      eventType: 'SELFTEST_DONE',
      subjectType: 'outbox_job',
      subjectId: String(job.id),
      details: { workerId: ctx.workerId, attempt: job.attempts },
    });
  });
  return 'COMPLETED_IN_TX';
};
