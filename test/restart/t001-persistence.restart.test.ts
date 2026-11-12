import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../src/db/migrate';
import { EvidenceCipher } from '../../src/crypto/cipher';
import { sha256Hex } from '../../src/domain/canonical';
import { money } from '../../src/domain/money';
import { createCase } from '../../src/services/cases';
import { admitEvidence } from '../../src/services/evidence';
import { insertRevision } from '../../src/services/revisions';
import { seedWorld } from '../support/fixtures';
import { PgCluster } from '../support/pg-cluster';
import { runTsx } from '../support/proc';

let cluster: PgCluster;
let url: string;
const key = randomBytes(32).toString('base64');

beforeAll(async () => {
  cluster = await PgCluster.start();
  const c = new pg.Client({ connectionString: cluster.url() });
  await c.connect();
  await c.query('create database t001');
  await c.end();
  url = cluster.url('t001');
  await migrateUp(url);
});
afterAll(() => cluster.destroy());

describe('T-001 — accepted evidence and proposal identity survive a database crash and a new process', () => {
  it('reads back identical digests, content and decryptable originals', async () => {
    const pool = new pg.Pool({ connectionString: url });
    const cipher = EvidenceCipher.fromBase64Key(key);
    const w = await seedWorld(pool);
    const kase = await createCase(pool, w.operator, {
      title: 'Refund for damaged blender',
      customerRef: 'ORD-77',
    });
    const text = 'The blender arrived cracked. Order ORD-77, paid 25.00 USD. Contact: sam@example.com';
    const ev = await admitEvidence(pool, cipher, w.operator, kase.id, { kind: 'SUPPORT_MESSAGE', text });
    const rev = await insertRevision(pool, w.operator, {
      caseId: kase.id,
      origin: 'HUMAN',
      content: {
        tenantId: w.tenantId,
        caseId: kase.id,
        captureId: 'CAPT001RESTART001',
        amount: { kind: 'EXACT', amount: money('USD', 2500n) },
        reason: { code: 'ITEM_DEFECTIVE', noteToPayer: 'Sorry about the damaged blender' },
        evidenceDigests: [ev.digest],
        policyVersion: 'policy-v1',
      },
    });
    await pool.end();

    await cluster.restart('immediate'); // crash: no shutdown checkpoint, WAL recovery on start

    const r = await runTsx('scripts/case-inspect.ts', [kase.id, '--verify', '--json'], {
      DATABASE_URL: url,
      REFUNDPROOF_DATA_KEY: key,
    });
    expect(r.code, r.output).toBe(0);
    const report = JSON.parse(r.output.slice(r.output.indexOf('{')));
    expect(report.case.id).toBe(kase.id);
    expect(report.evidence).toEqual([
      expect.objectContaining({
        id: ev.id,
        digest: ev.digest,
        digestVerified: true,
        originalSha256: sha256Hex(text),
      }),
    ]);
    expect(report.revisions).toEqual([
      expect.objectContaining({ id: rev.id, digest: rev.digest, digestVerified: true, state: 'DRAFT' }),
    ]);
    expect(r.output).not.toContain('sam@example.com');
  });
});
