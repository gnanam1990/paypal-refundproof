import type pg from 'pg';
import { backoffDelayMs } from '../domain/retry';
import type { Logger } from '../observability/log';
import { claimJobs, completeJob, failJob, renewLease, type Job, type JobKind } from '../queue/outbox';

export interface HandlerContext {
  pool: pg.Pool;
  workerId: string;
  log: Logger;
  /** Aborted when this worker loses the job's lease; handlers must stop before any further effect. */
  signal: AbortSignal;
}

/** Return 'COMPLETED_IN_TX' when the handler already marked the job DONE inside its own transaction. */
export type JobHandler = (job: Job, ctx: HandlerContext) => Promise<void | 'COMPLETED_IN_TX' | 'RESCHEDULED'>;

export interface WorkerOptions {
  pool: pg.Pool;
  workerId: string;
  handlers: Partial<Record<JobKind, JobHandler>>;
  leaseMs: number;
  pollMs: number;
  log: Logger;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

export class Worker {
  private stopping = new AbortController();
  private idleDelay: number;
  constructor(private readonly o: WorkerOptions) {
    this.idleDelay = o.pollMs;
  }

  get kinds(): JobKind[] {
    return Object.keys(this.o.handlers) as JobKind[];
  }

  async heartbeat() {
    await this.o.pool.query(
      `insert into worker_heartbeats (worker_id, pid, started_at, last_seen_at) values ($1, $2, now(), now())
       on conflict (worker_id) do update set last_seen_at = now(), pid = excluded.pid`,
      [this.o.workerId, process.pid],
    );
  }

  /** Claims and runs at most one job. Returns whether a job was processed. */
  async tick(): Promise<boolean> {
    const [job] = await claimJobs(this.o.pool, this.o.workerId, {
      limit: 1,
      leaseMs: this.o.leaseMs,
      kinds: this.kinds,
    });
    if (!job) return false;
    const log = this.o.log.child({
      jobId: job.id,
      kind: job.kind,
      operationId: job.operationId,
      attempt: job.attempts,
    });
    const lost = new AbortController();
    const renew = setInterval(
      () => {
        renewLease(this.o.pool, job, this.o.workerId, this.o.leaseMs)
          .then((ok) => {
            if (!ok) {
              log.log('warn', 'job.lease_lost');
              lost.abort();
            }
          })
          .catch(() => undefined); // database unavailable: keep trying; the lease may expire and be reclaimed
      },
      Math.max(50, Math.floor(this.o.leaseMs / 3)),
    );
    try {
      log.log('info', 'job.started');
      const outcome = await this.o.handlers[job.kind]!(job, {
        pool: this.o.pool,
        workerId: this.o.workerId,
        log,
        signal: lost.signal,
      });
      if (outcome !== 'COMPLETED_IN_TX' && outcome !== 'RESCHEDULED')
        await completeJob(this.o.pool, job, this.o.workerId);
      log.log('info', 'job.finished', { outcome: outcome ?? 'DONE' });
    } catch (e) {
      const delay = backoffDelayMs(
        { maxAttempts: 100, baseDelayMs: 500, maxDelayMs: 30_000, totalDeadlineMs: 86_400_000 },
        job.attempts,
      );
      log.log('error', 'job.failed', { error: e instanceof Error ? e.message : String(e) });
      await failJob(this.o.pool, job, this.o.workerId, e, delay).catch(() => undefined);
    } finally {
      clearInterval(renew);
    }
    return true;
  }

  async run() {
    this.o.log.log('info', 'worker.started', {
      workerId: this.o.workerId,
      kinds: this.kinds,
      leaseMs: this.o.leaseMs,
    });
    let lastBeat = 0;
    while (!this.stopping.signal.aborted) {
      try {
        if (Date.now() - lastBeat > 1_000) {
          await this.heartbeat();
          lastBeat = Date.now();
        }
        const worked = await this.tick();
        this.idleDelay = this.o.pollMs;
        if (!worked) await sleep(this.o.pollMs, this.stopping.signal);
      } catch (e) {
        // Database unavailable or similar: bounded backoff, never exit on transient failure.
        this.o.log.log('warn', 'worker.loop_error', { error: e instanceof Error ? e.message : String(e) });
        this.idleDelay = Math.min(this.idleDelay * 2, 2_000);
        await sleep(this.idleDelay, this.stopping.signal);
      }
    }
    this.o.log.log('info', 'worker.stopped', { workerId: this.o.workerId });
  }

  stop() {
    this.stopping.abort();
  }
}
