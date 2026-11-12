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
  /** Proposal model. 'none' = disabled; 'ollama' = real loopback model; local-fixture is deterministic dev-only. */
  REFUNDPROOF_MODEL_PROVIDER: z.enum(['none', 'anthropic', 'ollama', 'local-fixture']).default('none'),
  REFUNDPROOF_MODEL: z.string().min(1).max(100).default('claude-opus-5-5'),
  REFUNDPROOF_MODEL_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  REFUNDPROOF_MODEL_DEADLINE_MS: z.coerce.number().int().min(1_000).max(300_000).default(90_000),
  REFUNDPROOF_OLLAMA_ORIGIN: z.string().url().default('http://127.0.0.1:11434'),
  /** Capture lookups. 'none' = BLOCKED_CREDENTIAL; 'contract-stub' serves labelled fixtures (never production). */
  REFUNDPROOF_CAPTURE_SOURCE: z.enum(['none', 'contract-stub', 'paypal-sandbox']).default('none'),
  REFUNDPROOF_POLICY_VERSION: z.string().min(1).max(64).default('policy-v1'),
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
  if (r.data.NODE_ENV === 'production') {
    if (r.data.REFUNDPROOF_MODEL_PROVIDER === 'local-fixture')
      throw new ConfigError('invalid configuration: the local fixture model is not allowed in production');
    if (r.data.REFUNDPROOF_CAPTURE_SOURCE === 'contract-stub')
      throw new ConfigError('invalid configuration: contract-stub captures are not allowed in production');
  }
  return { ...r.data, secureCookies: r.data.APP_ORIGIN.startsWith('https://') };
}
