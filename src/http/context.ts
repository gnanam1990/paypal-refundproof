import type pg from 'pg';
import type { ProposalModel } from '../ai/model';
import type { EvidenceCipher } from '../crypto/cipher';
import type { PayPalClient } from '../paypal/client';
import type { CaptureSource } from '../services/captures';

export interface ApiConfig {
  /** Exact origin the console is served from; mutations from any other origin are refused. */
  appOrigin: string;
  sessionTtlMs: number;
  secureCookies: boolean;
  /** Failed logins per account per 15 minutes before 429. */
  loginRateLimit: number;
  /** Policy version bound into every revision digest. */
  policyVersion?: string;
  modelDeadlineMs?: number;
}

export interface ApiContext {
  pool: pg.Pool;
  cipher: EvidenceCipher;
  config: ApiConfig;
  /** Proposal model; null means no approved credential (BLOCKED_CREDENTIAL). */
  model?: ProposalModel | null;
  /** Capture lookup boundary; null means no capture source is configured. */
  captures?: CaptureSource | null;
  /** PayPal sandbox client; null means no sandbox credential (BLOCKED_CREDENTIAL). */
  paypal?: PayPalClient | null;
}
