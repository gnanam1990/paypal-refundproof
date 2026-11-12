import 'server-only';
import { loadConfig } from '../config';
import { EvidenceCipher } from '../crypto/cipher';
import { createPool } from '../db/pool';
import type { ApiContext } from '../http/context';
import { createApi } from '../http/router';

// One pool and handler per server process (survives Next.js dev hot reloads via globalThis).
const g = globalThis as unknown as {
  __refundproof?: { ctx: ApiContext; handle: (r: Request) => Promise<Response> };
};

export function appRuntime() {
  if (!g.__refundproof) {
    const cfg = loadConfig();
    const ctx: ApiContext = {
      pool: createPool(cfg.DATABASE_URL, { max: 10 }),
      cipher: EvidenceCipher.fromBase64Key(cfg.REFUNDPROOF_DATA_KEY),
      config: {
        appOrigin: cfg.APP_ORIGIN,
        sessionTtlMs: cfg.SESSION_TTL_MS,
        secureCookies: cfg.secureCookies,
        loginRateLimit: cfg.LOGIN_RATE_LIMIT,
      },
    };
    g.__refundproof = { ctx, handle: createApi(ctx) };
  }
  return g.__refundproof;
}
