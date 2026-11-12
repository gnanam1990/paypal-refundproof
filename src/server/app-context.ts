import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnthropicProposalModel, LocalFixtureProposalModel, type ProposalModel } from '../ai/model';
import { loadConfig, type AppConfig } from '../config';
import { EvidenceCipher } from '../crypto/cipher';
import { createPool } from '../db/pool';
import type { ApiContext } from '../http/context';
import { createApi } from '../http/router';
import { ContractStubCaptureSource, type CaptureSource } from '../services/captures';

function buildModel(cfg: AppConfig): ProposalModel | null {
  if (cfg.REFUNDPROOF_MODEL_PROVIDER === 'anthropic')
    return new AnthropicProposalModel(cfg.REFUNDPROOF_MODEL, cfg.REFUNDPROOF_MODEL_EFFORT);
  if (cfg.REFUNDPROOF_MODEL_PROVIDER === 'local-fixture') return new LocalFixtureProposalModel();
  return null; // BLOCKED_CREDENTIAL: proposals can still be written by hand
}

function buildCaptures(cfg: AppConfig): CaptureSource | null {
  if (cfg.REFUNDPROOF_CAPTURE_SOURCE === 'contract-stub') {
    const file = join(process.cwd(), 'fixtures', 'contract-stub-captures.json');
    return new ContractStubCaptureSource(JSON.parse(readFileSync(file, 'utf8')));
  }
  return null; // 'paypal-sandbox' is provided by the PayPal adapter (M04); 'none' is BLOCKED_CREDENTIAL
}

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
        policyVersion: cfg.REFUNDPROOF_POLICY_VERSION,
        modelDeadlineMs: cfg.REFUNDPROOF_MODEL_DEADLINE_MS,
      },
      model: buildModel(cfg),
      captures: buildCaptures(cfg),
    };
    g.__refundproof = { ctx, handle: createApi(ctx) };
  }
  return g.__refundproof;
}
