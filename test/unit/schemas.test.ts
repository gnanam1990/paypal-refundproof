import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeRevisionContent, encodeRevisionContent, revisionDigest } from '../../src/domain/proposal';
import { RevisionContentJson, revisionContentJsonSchema } from '../../src/domain/schemas';
import { arbRevisionContent } from '../support/arbitraries';

describe('revision content serialization', () => {
  it('round-trips through JSON without changing the digest', () => {
    fc.assert(
      fc.property(arbRevisionContent, (c) => {
        const wire = JSON.parse(JSON.stringify(encodeRevisionContent(c)));
        const back = decodeRevisionContent(wire);
        expect(revisionDigest(back)).toBe(revisionDigest(c));
      }),
    );
  });

  it('rejects extra fields, missing FULL consent semantics and invalid money', () => {
    const base = {
      tenantId: 'ten_a',
      caseId: 'case_a',
      captureId: 'ABCDEFGHIJKLMNOPQ',
      amount: { kind: 'EXACT', amount: { currency: 'USD', value: '10.00' } },
      reason: { code: 'GOODWILL', noteToPayer: null },
      evidenceDigests: ['a'.repeat(64)],
      policyVersion: 'policy-v1',
    };
    expect(RevisionContentJson.safeParse(base).success).toBe(true);
    expect(RevisionContentJson.safeParse({ ...base, approve: true }).success).toBe(false);
    expect(RevisionContentJson.safeParse({ ...base, amount: { kind: 'EXACT' } }).success).toBe(false);
    expect(RevisionContentJson.safeParse({ ...base, amount: undefined }).success).toBe(false);
    expect(
      RevisionContentJson.safeParse({
        ...base,
        amount: { kind: 'EXACT', amount: { currency: 'USD', value: '1.001' } },
      }).success,
    ).toBe(false);
    expect(
      RevisionContentJson.safeParse({
        ...base,
        amount: { kind: 'EXACT', amount: { currency: 'USD', value: '0.00' } },
      }).success,
    ).toBe(false);
    expect(RevisionContentJson.safeParse({ ...base, evidenceDigests: [] }).success).toBe(false);
  });

  it('emits a closed JSON Schema', () => {
    const schema = revisionContentJsonSchema() as { additionalProperties?: boolean; required?: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('amount');
  });
});
