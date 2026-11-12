import { describe, expect, it } from 'vitest';
import { deriveOperationIdentity } from '../../src/domain/identity';
import { money } from '../../src/domain/money';
import { revisionDigest, type RevisionContent } from '../../src/domain/proposal';
import vectors from '../../docs/evidence/M00/identity-vectors.json';

// Regression pin: the derivation must not drift, or retries across a deploy would mint a new request id.
describe('identity derivation vectors', () => {
  it('reproduces the recorded vectors exactly', () => {
    const content: RevisionContent = {
      tenantId: 'ten_vector',
      caseId: 'case_vector',
      captureId: '2GG279541U471931P',
      amount: { kind: 'EXACT', amount: money('USD', 1250n) },
      reason: { code: 'ITEM_DEFECTIVE', noteToPayer: 'Refund for damaged item' },
      evidenceDigests: ['a'.repeat(64)],
      policyVersion: 'policy-v1',
    };
    const digest = revisionDigest(content);
    expect(digest).toBe(vectors.digest);
    expect(revisionDigest({ ...content, amount: { kind: 'FULL', captureAmount: money('USD', 1250n) } })).toBe(
      vectors.full,
    );
    expect(
      deriveOperationIdentity({ tenantId: 'ten_vector', revisionId: 'rev_vector', revisionDigest: digest }),
    ).toEqual(vectors.identity);
  });
});
