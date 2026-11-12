import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Locate PostgreSQL server binaries: PG_BIN, pg_config, PATH, or Debian/Ubuntu layout (GitHub runners). */
export function findPgBin(): string {
  const candidates: string[] = [];
  if (process.env.PG_BIN) candidates.push(process.env.PG_BIN);
  try {
    candidates.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim());
  } catch {
    /* not on PATH */
  }
  for (const root of ['/usr/lib/postgresql', '/opt/homebrew/opt']) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root).sort().reverse()) {
      candidates.push(join(root, v, 'bin'));
    }
  }
  const found = candidates.find((d) => existsSync(join(d, 'initdb')) && existsSync(join(d, 'pg_ctl')));
  if (!found) throw new Error('PostgreSQL server binaries (initdb, pg_ctl) not found; set PG_BIN');
  return found;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

/** A real, disposable PostgreSQL cluster. restart('immediate') is a crash: no checkpoint, WAL recovery on start. */
export class PgCluster {
  private constructor(
    readonly bin: string,
    readonly dir: string,
    readonly port: number,
  ) {}

  static async start(): Promise<PgCluster> {
    const bin = findPgBin();
    const dir = mkdtempSync(join(tmpdir(), 'rp-pg-'));
    await run(
      join(bin, 'initdb'),
      ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale'],
      {
        env: { ...process.env, LC_ALL: 'C' },
      },
    );
    const c = new PgCluster(bin, dir, await freePort());
    await c.up();
    return c;
  }

  private async up() {
    await run(
      join(this.bin, 'pg_ctl'),
      [
        '-D',
        join(this.dir, 'data'),
        '-l',
        join(this.dir, 'server.log'),
        '-w',
        '-t',
        '60',
        '-o',
        `-p ${this.port} -k ${this.dir} -c listen_addresses=127.0.0.1 -c fsync=on -c max_connections=200`,
        'start',
      ],
      { env: { ...process.env, LC_ALL: 'C' } },
    );
  }

  async stop(mode: 'fast' | 'immediate' = 'fast') {
    await run(join(this.bin, 'pg_ctl'), ['-D', join(this.dir, 'data'), '-m', mode, '-w', 'stop'], {
      env: { ...process.env, LC_ALL: 'C' },
    });
  }

  /** Stop (crash-style by default) and start again on the same port and data directory. */
  async restart(mode: 'fast' | 'immediate' = 'immediate') {
    await this.stop(mode);
    await this.up();
  }

  url(db = 'postgres') {
    return `postgres://postgres@127.0.0.1:${this.port}/${db}`;
  }

  async destroy() {
    try {
      await this.stop('immediate');
    } catch {
      /* already stopped */
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}
