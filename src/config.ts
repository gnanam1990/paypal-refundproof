import { z } from 'zod';

/**
 * Server-side configuration. Secrets are read from the environment (a gitignored `.env.local` in development)
 * and never reach the browser bundle: nothing here is prefixed NEXT_PUBLIC_.
 */
const Env = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REFUNDPROOF_DATA_KEY: z.string().min(1, 'REFUNDPROOF_DATA_KEY is required (32 random bytes, base64)'),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 3_600_000),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(5),
  NODE_ENV: z.string().default('development'),
});

export type AppConfig = z.infer<typeof Env> & { secureCookies: boolean };

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const r = Env.safeParse(env);
  if (!r.success) {
    // Report names only; never echo values.
    throw new ConfigError(
      `invalid configuration: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return { ...r.data, secureCookies: r.data.APP_ORIGIN.startsWith('https://') };
}
