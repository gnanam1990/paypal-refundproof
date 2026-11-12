import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, forbidden, unauthenticated, type Actor } from '../auth/actor';
import { verifyPassword } from '../auth/password';
import { createSession, resolveSession, revokeSession, type ResolvedSession } from '../auth/sessions';
import { appendAudit } from '../services/audit';
import { caseAuditTrail, createCase, getCaseForActor, listCases } from '../services/cases';
import { admitEvidence, listEvidence } from '../services/evidence';
import { countInWindow, rateLimited, recordHit } from '../services/rate-limit';
import { listRevisions } from '../services/revisions';
import type { ApiContext } from './context';
import { errorResponse, json } from './respond';

export const SESSION_COOKIE = 'rp_session';
const MAX_BODY_BYTES = 128 * 1024;

export interface RequestState {
  req: Request;
  ctx: ApiContext;
  params: Record<string, string>;
  session: ResolvedSession | null;
}

export type RouteHandler = (s: RequestState & { actor: Actor; body: unknown }) => Promise<Response>;

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  keys: string[];
  auth: boolean;
  handler: RouteHandler;
}

const routes: Route[] = [];

/** Registers a route. `:name` segments become params. Exported so later modules add their endpoints. */
export function route(
  method: Route['method'],
  path: string,
  handler: RouteHandler,
  opts: { auth?: boolean } = {},
) {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => {
      keys.push(k);
      return '([A-Za-z0-9_-]{1,80})';
    })}$`,
  );
  routes.push({ method, pattern, keys, auth: opts.auth ?? true, handler });
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function sessionCookie(ctx: ApiContext, token: string, maxAgeSec: number) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${ctx.config.secureCookies ? '; Secure' : ''}`;
}

async function readBody(req: Request): Promise<unknown> {
  if (req.method === 'GET') return undefined;
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES)
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  if (!text) return {};
  const type = req.headers.get('content-type') ?? '';
  if (type.startsWith('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError(400, 'BAD_JSON', 'Request body is not valid JSON');
    }
  }
  throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json');
}

/** Builds the API request handler. Every mutation requires same-origin + the session's CSRF token. */
export function createApi(ctx: ApiContext): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      const url = new URL(req.url);
      const match = routes
        .filter((r) => r.method === req.method)
        .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
        .find((x) => x.m);
      if (!match) {
        const anyMethod = routes.some((r) => r.pattern.test(url.pathname));
        throw new AppError(
          anyMethod ? 405 : 404,
          anyMethod ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
          'No such endpoint',
        );
      }
      const params = Object.fromEntries(match.r.keys.map((k, i) => [k, match.m![i + 1]!]));
      if (req.method !== 'GET') {
        const origin = req.headers.get('origin');
        if (!origin || origin !== ctx.config.appOrigin) throw forbidden('Cross-origin request refused');
      }
      const session = await resolveSession(ctx.pool, readCookie(req, SESSION_COOKIE));
      if (match.r.auth) {
        if (!session) throw unauthenticated();
        if (req.method !== 'GET') {
          const token = req.headers.get('x-csrf-token') ?? '';
          if (!token || !safeEqual(token, session.csrfToken))
            throw forbidden('Missing or invalid CSRF token');
        }
      }
      const body = await readBody(req);
      return await match.r.handler({ req, ctx, params, session, actor: session?.actor as Actor, body });
    } catch (e) {
      return errorResponse(e, ctx.pool);
    }
  };
}

// ------------------------------------------------------------------------------------------------ auth

const LoginInput = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});
const LOGIN_WINDOW_MS = 15 * 60_000;

route(
  'POST',
  '/api/auth/login',
  async ({ ctx, body }) => {
    const v = LoginInput.parse(body);
    const key = `login-fail:${v.email}`;
    if ((await countInWindow(ctx.pool, key, LOGIN_WINDOW_MS)) >= ctx.config.loginRateLimit)
      throw rateLimited('sign-in attempts');
    const r = await ctx.pool.query('select * from actors where email = $1 and not disabled', [v.email]);
    const row = r.rows[0];
    const ok = await verifyPassword(v.password, row?.password_hash ?? null);
    if (!row || !ok) {
      await recordHit(ctx.pool, key);
      await appendAudit(ctx.pool, {
        tenantId: row?.tenant_id ?? null,
        actorId: row?.id ?? null,
        eventType: 'AUTH_LOGIN',
        subjectType: 'actor',
        subjectId: row?.id ?? 'unknown',
        outcome: 'DENIED',
        details: { reason: 'invalid credentials' },
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    const s = await createSession(ctx.pool, row.id, ctx.config.sessionTtlMs);
    await appendAudit(ctx.pool, {
      tenantId: row.tenant_id,
      actorId: row.id,
      eventType: 'AUTH_LOGIN',
      subjectType: 'actor',
      subjectId: row.id,
    });
    return json(
      200,
      {
        actor: {
          id: row.id,
          tenantId: row.tenant_id,
          role: row.role,
          email: row.email,
          displayName: row.display_name,
          seeded: row.seeded,
        },
        csrfToken: s.csrfToken,
        expiresAt: s.expiresAt.toISOString(),
      },
      { 'set-cookie': sessionCookie(ctx, s.token, Math.floor(ctx.config.sessionTtlMs / 1000)) },
    );
  },
  { auth: false },
);

route('POST', '/api/auth/logout', async ({ ctx, session }) => {
  await revokeSession(ctx.pool, session!.tokenHash);
  return json(200, { ok: true }, { 'set-cookie': sessionCookie(ctx, '', 0) });
});

route('GET', '/api/session', async ({ session }) =>
  json(200, { actor: session!.actor, csrfToken: session!.csrfToken }),
);

// ------------------------------------------------------------------------------------------------ cases

route('GET', '/api/cases', async ({ ctx, actor }) => json(200, { cases: await listCases(ctx.pool, actor) }));

route('POST', '/api/cases', async ({ ctx, actor, body }) =>
  json(201, { case: await createCase(ctx.pool, actor, body) }),
);

route('GET', '/api/cases/:caseId', async ({ ctx, actor, params }) => {
  const kase = await getCaseForActor(ctx.pool, actor, params.caseId!);
  const [evidence, revisions] = await Promise.all([
    listEvidence(ctx.pool, actor, kase.id),
    listRevisions(ctx.pool, actor, kase.id),
  ]);
  return json(200, { case: kase, evidence, revisions: revisions.map(({ content: _c, ...r }) => r) });
});

route('POST', '/api/cases/:caseId/evidence', async ({ ctx, actor, params, body }) => {
  const { created, ...evidence } = await admitEvidence(ctx.pool, ctx.cipher, actor, params.caseId!, body);
  return json(created ? 201 : 200, { evidence });
});

route('GET', '/api/cases/:caseId/audit', async ({ ctx, actor, params }) =>
  json(200, await caseAuditTrail(ctx.pool, actor, params.caseId!)),
);
