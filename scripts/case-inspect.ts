// Operator CLI: print a case's durable, redacted evidence trail and verify every stored digest.
//   tsx scripts/case-inspect.ts <caseId> [--verify] [--json]
// Requires DATABASE_URL; --verify also needs REFUNDPROOF_DATA_KEY to re-derive evidence digests from the
// encrypted originals. Originals and unkeyed hashes of them are never printed.
import pg from 'pg';
import { EvidenceCipher } from '../src/crypto/cipher';
import { sha256Hex } from '../src/domain/canonical';
import { DigestMismatchError, toStoredRevision } from '../src/services/revisions';

const [caseId, ...flags] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!caseId || !url) {
  console.error('usage: DATABASE_URL=... tsx scripts/case-inspect.ts <caseId> [--verify] [--json]');
  process.exit(2);
}
const verify = flags.includes('--verify');
const cipher =
  verify && process.env.REFUNDPROOF_DATA_KEY
    ? EvidenceCipher.fromBase64Key(process.env.REFUNDPROOF_DATA_KEY)
    : null;
if (verify && !cipher) {
  console.error('--verify requires REFUNDPROOF_DATA_KEY');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const c = (
    await client.query('select id, tenant_id, title, status, created_at from cases where id = $1', [caseId])
  ).rows[0];
  if (!c) {
    console.error('case not found');
    process.exit(1);
  }
  const ev = (
    await client.query('select * from evidence_artifacts where case_id = $1 order by admitted_at, id', [
      caseId,
    ])
  ).rows;
  const revs = (
    await client.query('select * from proposal_revisions where case_id = $1 order by revision_no', [caseId])
  ).rows;
  const ops = (
    await client.query(
      'select id, state, paypal_request_id, approved_revision_id, refund_id, created_at from refund_operations where case_id = $1 order by created_at',
      [caseId],
    )
  ).rows;
  let failures = 0;
  const report = {
    case: { id: c.id, tenantId: c.tenant_id, title: c.title, status: c.status },
    evidence: ev.map((e) => {
      const out: Record<string, unknown> = {
        id: e.id,
        kind: e.kind,
        digest: e.digest,
        redactedText: e.redacted_text,
      };
      if (cipher) {
        const original = cipher.decrypt(e.encrypted_original).toString('utf8');
        out.digestVerified =
          cipher.evidenceDigest(e.kind, original) === e.digest &&
          sha256Hex(e.redacted_text) === e.redacted_digest;
        if (!out.digestVerified) failures++;
      }
      return out;
    }),
    revisions: revs.map((r) => {
      let digestVerified = true;
      try {
        toStoredRevision(r);
      } catch (e) {
        if (!(e instanceof DigestMismatchError)) throw e;
        digestVerified = false;
        failures++;
      }
      return { id: r.id, revisionNo: r.revision_no, state: r.state, digest: r.digest, digestVerified };
    }),
    operations: ops.map((o) => ({
      id: o.id,
      state: o.state,
      paypalRequestId: o.paypal_request_id,
      approvedRevisionId: o.approved_revision_id,
      refundId: o.refund_id,
    })),
  };
  console.log(JSON.stringify(report, null, flags.includes('--json') ? 0 : 2));
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await client.end();
}
