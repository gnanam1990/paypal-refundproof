#!/usr/bin/env node
// Creates .env.local for local development if it does not exist: a fresh random evidence-encryption key and a
// local DATABASE_URL. Provider credentials (PayPal sandbox, model API) are left for the operator to fill in.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const target = '.env.local';
if (existsSync(target)) {
  console.log(`${target} exists; leaving it unchanged`);
  process.exit(0);
}
const template = readFileSync('.env.example', 'utf8');
const out = template
  .replace(/^REFUNDPROOF_DATA_KEY=.*$/m, `REFUNDPROOF_DATA_KEY=${randomBytes(32).toString('base64')}`)
  .replace(
    /^DATABASE_URL=.*$/m,
    `DATABASE_URL=${process.env.DATABASE_URL ?? 'postgres://localhost:5432/refundproof'}`,
  );
writeFileSync(target, out, { mode: 0o600 });
console.log(`wrote ${target} (mode 600) with a new random REFUNDPROOF_DATA_KEY`);
