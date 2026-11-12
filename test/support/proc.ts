import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Spawns ONE real Node process running a repository entry point (tsx as an in-process loader). The `tsx` CLI
 * forks a child, so signalling it would orphan the actual worker — which T-008 caught.
 */
export function spawnTsx(
  entry: string,
  args: string[],
  env: Record<string, string>,
): ChildProcess & { output: () => string } {
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, entry), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  return Object.assign(child, { output: () => out });
}

export async function runTsx(entry: string, args: string[], env: Record<string, string>) {
  const c = spawnTsx(entry, args, env);
  const code: number = await new Promise((r) => c.on('exit', (x) => r(x ?? -1)));
  return { code, output: c.output() };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* transient (e.g. database restarting) */
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
