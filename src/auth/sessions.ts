import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool';
import type { Actor } from './actor';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function createSession(db: Queryable, actorId: string, ttlMs: number) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.query(
    'insert into sessions (token_hash, actor_id, csrf_token, expires_at) values ($1, $2, $3, $4)',
    [hashToken(token), actorId, csrfToken, expiresAt],
  );
  return { token, csrfToken, expiresAt };
}

export interface ResolvedSession {
  actor: Actor;
  csrfToken: string;
  tokenHash: string;
}

export async function resolveSession(
  db: Queryable,
  token: string | undefined,
): Promise<ResolvedSession | null> {
  if (!token || token.length > 128) return null;
  const r = await db.query(
    `select a.id, a.tenant_id, a.role, a.email, a.display_name, a.seeded, s.csrf_token, s.token_hash
       from sessions s join actors a on a.id = s.actor_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and not a.disabled`,
    [hashToken(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    actor: {
      id: row.id,
      tenantId: row.tenant_id,
      role: row.role,
      email: row.email,
      displayName: row.display_name,
      seeded: row.seeded,
    },
    csrfToken: row.csrf_token,
    tokenHash: row.token_hash,
  };
}

export async function revokeSession(db: Queryable, tokenHash: string) {
  await db.query('update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [
    tokenHash,
  ]);
}
