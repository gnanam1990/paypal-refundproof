import fc from 'fast-check';
import { CURRENCY_EXPONENTS, MAX_MINOR, money, type CurrencyCode } from '../../src/domain/money';
import { REFUND_REASON_CODES, type RevisionContent } from '../../src/domain/proposal';

const currencies = Object.keys(CURRENCY_EXPONENTS) as CurrencyCode[];
const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);
const id = (prefix: string) => fc.stringMatching(/^[a-z0-9]{8,20}$/).map((s) => `${prefix}_${s}`);

export const arbMoney = fc
  .tuple(fc.constantFrom(...currencies), fc.bigInt({ min: 1n, max: MAX_MINOR }))
  .map(([c, m]) => money(c, m));

export const arbAmount = fc.oneof(
  arbMoney.map((amount) => ({ kind: 'EXACT' as const, amount })),
  arbMoney.map((captureAmount) => ({ kind: 'FULL' as const, captureAmount })),
);

export const arbRevisionContent: fc.Arbitrary<RevisionContent> = fc.record({
  tenantId: id('ten'),
  caseId: id('case'),
  captureId: fc.stringMatching(/^[0-9A-Z]{17}$/),
  amount: arbAmount,
  reason: fc.record({
    code: fc.constantFrom(...REFUND_REASON_CODES),
    noteToPayer: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: null }),
  }),
  evidenceDigests: fc.uniqueArray(hex64, { minLength: 1, maxLength: 4 }),
  policyVersion: fc.constantFrom('policy-v1', 'policy-v2'),
});

export const arbRevisionId = id('rev');
