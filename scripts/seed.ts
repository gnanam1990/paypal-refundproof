// Creates one clearly LABELED demo tenant with an operator, an approver and an admin for local sandbox use.
//   DATABASE_URL=... tsx scripts/seed.ts
// Refuses to run when NODE_ENV=production. Passwords are development-only values printed to
// .local/seed-accounts.json (gitignored), never to stdout.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createActor, createTenant } from '../src/services/tenancy';

if (process.env.NODE_ENV === 'production') {
  console.error('seed refused: NODE_ENV=production');
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url });
try {
  const existing = await pool.query(`select count(*)::int n from actors where seeded`);
  if (existing.rows[0].n > 0) {
    console.log('seed: labeled demo accounts already exist; see .local/seed-accounts.json');
    process.exit(0);
  }
  const t = await createTenant(pool, 'DEMO — Sandbox Merchant (seeded)');
  const accounts = [];
  for (const [role, name] of [
    ['OPERATOR', 'Demo Operator (seeded)'],
    ['APPROVER', 'Demo Approver (seeded)'],
    ['ADMIN', 'Demo Admin (seeded)'],
  ] as const) {
    const password = `dev-${randomBytes(12).toString('base64url')}`;
    const email = `${role.toLowerCase()}@demo.refundproof.test`;
    await createActor(pool, { tenantId: t.id, role, email, displayName: name, password, seeded: true });
    accounts.push({ role, email, password });
  }
  mkdirSync('.local', { recursive: true });
  writeFileSync(
    '.local/seed-accounts.json',
    `${JSON.stringify({ tenantId: t.id, label: 'SEEDED DEMO ACCOUNTS — development only', accounts }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  console.log(
    `seed: created labeled demo tenant ${t.id} with 3 accounts; credentials in .local/seed-accounts.json`,
  );
} finally {
  await pool.end();
}
