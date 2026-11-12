import { withTx } from '../db/pool';
import { completeJob, LeaseLostError } from '../queue/outbox';
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
    // Fenced completion first: it locks the job row and throws LeaseLostError unless this exact claim (id, owner,
    // fence) still holds an unexpired lease, so the effect below commits only with the live claim's completion.
    if ((await completeJob(c, job, ctx.workerId)) === 'ALREADY_COMPLETED') return;
    await appendAudit(c, {
      tenantId: job.tenantId,
      actorId: null,
      eventType: 'SELFTEST_DONE',
      subjectType: 'outbox_job',
      subjectId: String(job.id),
      details: { workerId: ctx.workerId, attempt: job.attempts, fence: job.fence },
    });
  });
  return 'COMPLETED_IN_TX';
};
