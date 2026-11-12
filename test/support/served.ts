import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { waitFor } from './proc';

const ROOT = join(import.meta.dirname, '..', '..');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

/** Starts the production build (`next start`) as a real process. Requires `pnpm build` first. */
export async function startWeb(
  port: number,
  env: Record<string, string>,
): Promise<ChildProcess & { output: () => string }> {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)],
    {
      cwd: ROOT,
      env: { ...process.env, ...env, NODE_ENV: 'production', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const proc = Object.assign(child, { output: () => out });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok, 60_000, `web on :${port}`);
  return proc;
}

export async function stopProcess(p: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (p.exitCode !== null) return;
  const exited = new Promise((r) => p.on('exit', r));
  p.kill(signal);
  await exited;
}
