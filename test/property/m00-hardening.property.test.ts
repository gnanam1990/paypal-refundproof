// Post-merge corrective tests for M00 (findings H1–H4 against merged head 4ed3926).
import Ajv2020 from 'ajv/dist/2020';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { approvalDigest, deriveOperationIdentity, IdentityError } from '../../src/domain/identity';
import { CURRENCY_EXPONENTS, MAX_MINOR, money, parseMoney, type CurrencyCode } from '../../src/domain/money';
import {
  MAX_EVIDENCE_DIGESTS,
  ProposalContentError,
  revisionDigest,
  type RevisionContent,
} from '../../src/domain/proposal';
import { revisionContentJsonSchema } from '../../src/domain/schemas';
import { arbRevisionContent, arbRevisionId } from '../support/arbitraries';

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(revisionContentJsonSchema() as object);

const base = {
  tenantId: 'ten_a',
  caseId: 'case_a',
  captureId: 'ABCDEFGHIJKLMNOPQ',
  amount: { kind: 'EXACT', amount: { currency: 'USD', value: '10.00' } },
  reason: { code: 'GOODWILL', noteToPayer: null },
  evidenceDigests: ['a'.repeat(64)],
  policyVersion: 'policy-v1',
};
const withMoney = (currency: string, value: string) => ({
  ...base,
  amount: { kind: 'EXACT', amount: { currency, value } },
});
const withFull = (currency: string, value: string) => ({
  ...base,
  amount: { kind: 'FULL', captureAmount: { currency, value } },
});

describe('H1 — the exported JSON Schema enforces what the domain enforces', () => {
  it('accepts valid content', () => {
    expect(validate(base)).toBe(true);
    expect(validate(withMoney('JPY', '1500'))).toBe(true);
    expect(validate(withMoney('USD', '0.01'))).toBe(true);
    expect(validate(withMoney('USD', '9999999999.99'))).toBe(true);
    expect(validate(withMoney('JPY', '999999999999'))).toBe(true);
  });

  it.each([
    ['USD 1.001 (beyond exponent)', withMoney('USD', '1.001')],
    ['JPY 1.5 (zero-exponent currency)', withMoney('JPY', '1.5')],
    ['HUF 1.0', withMoney('HUF', '1.0')],
    ['USD 0.00 (zero)', withMoney('USD', '0.00')],
    ['USD 0', withMoney('USD', '0')],
    ['JPY 0', withMoney('JPY', '0')],
    ['USD over MAX_MINOR', withMoney('USD', '10000000000.00')],
    ['JPY over MAX_MINOR', withMoney('JPY', '1000000000000')],
    ['FULL capture amount 0.00', withFull('USD', '0.00')],
    ['FULL JPY 1.5', withFull('JPY', '1.5')],
    ['leading zero', withMoney('USD', '01.00')],
    ['non-hex evidence digest', { ...base, evidenceDigests: ['z'.repeat(64)] }],
    ['short evidence digest', { ...base, evidenceDigests: ['a'.repeat(63)] }],
    ['uppercase evidence digest', { ...base, evidenceDigests: ['A'.repeat(64)] }],
    [
      '65 evidence digests',
      { ...base, evidenceDigests: Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(64, '0')) },
    ],
    ['empty evidence', { ...base, evidenceDigests: [] }],
  ])('rejects %s', (_label, doc) => {
    expect(validate(doc)).toBe(false);
  });

  it('agrees with the domain parser on arbitrary amount strings (differential)', () => {
    const currencies = Object.keys(CURRENCY_EXPONENTS) as CurrencyCode[];
    const arbValue = fc.oneof(
      fc.stringMatching(/^[0-9]{1,14}(\.[0-9]{0,4})?$/),
      fc.bigInt({ min: 0n, max: MAX_MINOR * 11n }).map((n) => n.toString()),
      fc.constantFrom('0', '0.0', '0.00', '0.01', '.5', '1.', '00', '9999999999.99', '10000000000.00'),
    );
    fc.assert(
      fc.property(fc.constantFrom(...currencies), arbValue, (currency, value) => {
        let domainOk: boolean;
        try {
          domainOk = parseMoney(value, currency).minor > 0n;
        } catch {
          domainOk = false;
        }
        expect(validate(withMoney(currency, value))).toBe(domainOk);
      }),
      { numRuns: 2000 },
    );
  });

  it('accepts every positive in-range money value the domain can produce', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...(Object.keys(CURRENCY_EXPONENTS) as CurrencyCode[])),
        fc.bigInt({ min: 1n, max: MAX_MINOR }),
        (currency, minor) => {
          const m = money(currency, minor);
          const exp = CURRENCY_EXPONENTS[currency];
          const s = m.minor.toString().padStart(exp + 1, '0');
          const value = exp === 0 ? s : `${s.slice(0, -exp)}.${s.slice(-exp)}`;
          expect(validate(withMoney(currency, value))).toBe(true);
        },
      ),
    );
  });
});

describe('H2 — approval digest rejects impossible instants and empty identifiers', () => {
  const b = {
    tenantId: 't',
    revisionId: 'r',
    revisionDigest: 'a'.repeat(64),
    approverId: 'u',
    policyVersion: 'p1',
  };

  it.each([
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z', // 2026 is not a leap year
    '2026-04-31T12:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-11-12T24:00:00Z',
    '2026-11-12T23:60:00Z',
    '2026-11-12T23:59:60Z',
  ])('rejects impossible instant %s', (expiresAt) => {
    expect(() => approvalDigest({ ...b, expiresAt })).toThrow(IdentityError);
  });

  it('accepts real instants, including a leap day', () => {
    expect(() => approvalDigest({ ...b, expiresAt: '2028-02-29T23:59:59.999Z' })).not.toThrow();
    expect(() => approvalDigest({ ...b, expiresAt: '2026-11-12T10:00:00Z' })).not.toThrow();
  });

  it.each(['tenantId', 'revisionId', 'approverId', 'policyVersion'] as const)('rejects an empty %s', (k) => {
    expect(() => approvalDigest({ ...b, [k]: '', expiresAt: '2026-11-12T10:00:00Z' })).toThrow(IdentityError);
    expect(() => approvalDigest({ ...b, [k]: 'x'.repeat(129), expiresAt: '2026-11-12T10:00:00Z' })).toThrow(
      IdentityError,
    );
  });
});

describe('H3 — T-006 full chain: changed intent → new revision, new approval, new operation', () => {
  const mutate = (c: RevisionContent, which: 'amount' | 'capture'): RevisionContent =>
    which === 'capture'
      ? { ...c, captureId: c.captureId === 'Z'.repeat(17) ? 'Y'.repeat(17) : 'Z'.repeat(17) }
      : c.amount.kind === 'EXACT'
        ? {
            ...c,
            amount: {
              kind: 'EXACT',
              amount: money(c.amount.amount.currency, c.amount.amount.minor === 1n ? 2n : 1n),
            },
          }
        : { ...c, amount: { kind: 'EXACT', amount: c.amount.captureAmount } };

  it.each(['amount', 'capture'] as const)(
    'changing %s yields three fresh, unlinkable identities',
    (which) => {
      fc.assert(
        fc.property(
          arbRevisionContent,
          arbRevisionId,
          arbRevisionId,
          fc.constantFrom('act_approver1', 'act_approver2'),
          (c, r1, r2, approverId) => {
            fc.pre(r1 !== r2); // a changed intent is always stored as a new server-generated revision
            const changed = mutate(c, which);
            const expiresAt = '2026-11-12T10:30:00.000Z';
            const d1 = revisionDigest(c);
            const d2 = revisionDigest(changed);
            // new revision
            expect(d2).not.toBe(d1);
            // new approval: the old approval's digest can never authorize the new revision
            const a1 = approvalDigest({
              tenantId: c.tenantId,
              revisionId: r1,
              revisionDigest: d1,
              approverId,
              policyVersion: c.policyVersion,
              expiresAt,
            });
            const a2 = approvalDigest({
              tenantId: c.tenantId,
              revisionId: r2,
              revisionDigest: d2,
              approverId,
              policyVersion: c.policyVersion,
              expiresAt,
            });
            const replayed = approvalDigest({
              tenantId: c.tenantId,
              revisionId: r2,
              revisionDigest: d1,
              approverId,
              policyVersion: c.policyVersion,
              expiresAt,
            });
            expect(a2).not.toBe(a1);
            expect(replayed).not.toBe(a2);
            // new operation and request identities
            const o1 = deriveOperationIdentity({ tenantId: c.tenantId, revisionId: r1, revisionDigest: d1 });
            const o2 = deriveOperationIdentity({ tenantId: c.tenantId, revisionId: r2, revisionDigest: d2 });
            for (const k of ['operationId', 'paypalRequestId', 'invoiceId', 'customId'] as const)
              expect(o2[k]).not.toBe(o1[k]);
          },
        ),
      );
    },
  );
});

describe('H4 — evidence digest count is bounded before dedup/sort', () => {
  const digests = (n: number) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, '0'));
  const content = (evidenceDigests: string[]): RevisionContent => ({
    tenantId: 't',
    caseId: 'c',
    captureId: 'CAP',
    amount: { kind: 'EXACT', amount: money('USD', 100n) },
    reason: { code: 'GOODWILL', noteToPayer: null },
    evidenceDigests,
    policyVersion: 'p1',
  });

  it('exposes the shared bound', () => {
    expect(MAX_EVIDENCE_DIGESTS).toBe(64);
  });

  it('accepts exactly 64 and rejects 65 distinct digests', () => {
    expect(() => revisionDigest(content(digests(64)))).not.toThrow();
    expect(() => revisionDigest(content(digests(65)))).toThrow(ProposalContentError);
  });

  it('rejects an oversized input even when duplicates would dedup below the bound', () => {
    const dup = Array.from({ length: 1000 }, () => 'a'.repeat(64));
    expect(() => revisionDigest(content(dup))).toThrow(ProposalContentError);
  });
});
