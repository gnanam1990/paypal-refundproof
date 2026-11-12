import type pg from 'pg';
import type { EvidenceCipher } from '../crypto/cipher';

export interface ApiConfig {
  /** Exact origin the console is served from; mutations from any other origin are refused. */
  appOrigin: string;
  sessionTtlMs: number;
  secureCookies: boolean;
  /** Failed logins per account per 15 minutes before 429. */
  loginRateLimit: number;
}

export interface ApiContext {
  pool: pg.Pool;
  cipher: EvidenceCipher;
  config: ApiConfig;
}
