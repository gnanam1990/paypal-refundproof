import { hostname } from 'node:os';
import { createPool } from '../db/pool';
import { rootLogger } from '../observability/log';
import { buildHandlers } from './handlers';
import { Worker } from './runner';

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const pool = createPool(url, { max: 5 });
  const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
  const log = rootLogger.child({ process: 'worker', workerId });
  const worker = new Worker({
    pool,
    workerId,
    handlers: await buildHandlers({ pool, log }),
    leaseMs: int(process.env.WORKER_LEASE_MS, 30_000),
    pollMs: int(process.env.WORKER_POLL_MS, 500),
    log,
  });
  const shutdown = () => worker.stop();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await worker.run();
  await pool.end().catch(() => undefined);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
