import type pg from 'pg';
import { z } from 'zod';
import { requireRole, type Actor } from '../auth/actor';
import type { EvidenceCipher } from '../crypto/cipher';
import { withTx, type Queryable } from '../db/pool';
import { sha256Hex } from '../domain/canonical';
import { redact } from '../evidence/redact';
import { newId } from '../ids';
import { appendAudit } from './audit';
import { getCaseForActor } from './cases';

export const MAX_EVIDENCE_BYTES = 65_536;

export const AdmitEvidenceInput = z.strictObject({
  kind: z.enum(['SUPPORT_MESSAGE', 'ORDER_NOTE', 'OPERATOR_NOTE']),
  text: z
    .string()
    .min(1)
    .refine((t) => Buffer.byteLength(t, 'utf8') <= MAX_EVIDENCE_BYTES, `at most ${MAX_EVIDENCE_BYTES} bytes`),
});

export interface PublicEvidence {
  id: string;
  caseId: string;
  kind: string;
  digest: string;
  redactedText: string;
  redactedDigest: string;
  redactionReport: unknown;
  originalBytes: number;
  admittedBy: string;
  admittedAt: string;
}

// Evidence digests are keyed (EvidenceCipher.evidenceDigest): an unkeyed hash of the original would let anyone
// holding the digest confirm a guessed original and so defeat redaction.

const toPublic = (r: Record<string, unknown>): PublicEvidence => ({
  id: r.id as string,
  caseId: r.case_id as string,
  kind: r.kind as string,
  digest: r.digest as string,
  redactedText: r.redacted_text as string,
  redactedDigest: r.redacted_digest as string,
  redactionReport: r.redaction_report,
  originalBytes: r.original_bytes as number,
  admittedBy: r.admitted_by as string,
  admittedAt: new Date(r.admitted_at as string).toISOString(),
});

/**
 * Admits evidence: the original is encrypted at rest, a deterministic redacted copy is the only form ever
 * displayed or sent to a model, and the digest binds the exact original. Re-admitting identical evidence
 * returns the existing artifact.
 */
export async function admitEvidence(
  pool: pg.Pool,
  cipher: EvidenceCipher,
  actor: Actor,
  caseId: string,
  input: unknown,
): Promise<PublicEvidence & { created: boolean }> {
  requireRole(actor, 'OPERATOR', 'ADMIN');
  const v = AdmitEvidenceInput.parse(input);
  return withTx(pool, async (c) => {
    await getCaseForActor(c, actor, caseId, true);
    const digest = cipher.evidenceDigest(v.kind, v.text);
    const red = redact(v.text);
    const id = newId('ev');
    const ins = await c.query(
      `insert into evidence_artifacts (id, tenant_id, case_id, kind, digest, redacted_text, redacted_digest,
         encrypted_original, encryption_key_id, original_bytes, redaction_report, admitted_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (case_id, digest) do nothing returning *`,
      [
        id,
        actor.tenantId,
        caseId,
        v.kind,
        digest,
        red.text,
        sha256Hex(red.text),
        cipher.encrypt(Buffer.from(v.text, 'utf8')),
        cipher.keyId,
        Buffer.byteLength(v.text, 'utf8'),
        JSON.stringify(red.report),
        actor.id,
      ],
    );
    if (!ins.rows[0]) {
      const existing = await c.query('select * from evidence_artifacts where case_id = $1 and digest = $2', [
        caseId,
        digest,
      ]);
      return { ...toPublic(existing.rows[0]), created: false };
    }
    await appendAudit(c, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      eventType: 'EVIDENCE_ADMITTED',
      subjectType: 'evidence',
      subjectId: id,
      details: { caseId, kind: v.kind, digest, redactions: red.report.rules },
    });
    return { ...toPublic(ins.rows[0]), created: true };
  });
}

export async function listEvidence(db: Queryable, actor: Actor, caseId: string): Promise<PublicEvidence[]> {
  const r = await db.query(
    'select * from evidence_artifacts where case_id = $1 and tenant_id = $2 order by admitted_at, id',
    [caseId, actor.tenantId],
  );
  return r.rows.map(toPublic);
}
