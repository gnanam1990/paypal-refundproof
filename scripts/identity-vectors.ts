// Prints derived identities for fixed inputs. Run twice (or on two machines) and diff to prove determinism.
import { deriveOperationIdentity } from '../src/domain/identity';
import { money } from '../src/domain/money';
import { revisionDigest, type RevisionContent } from '../src/domain/proposal';

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
const full = revisionDigest({ ...content, amount: { kind: 'FULL', captureAmount: money('USD', 1250n) } });
console.log(
  JSON.stringify(
    {
      digest,
      full,
      identity: deriveOperationIdentity({
        tenantId: 'ten_vector',
        revisionId: 'rev_vector',
        revisionDigest: digest,
      }),
    },
    null,
    2,
  ),
);
