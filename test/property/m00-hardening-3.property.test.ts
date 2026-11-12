// Post-merge corrective hardening #2 — findings from the independent review of merged head af73ca0.
// F1 (HIGH): decodeRevisionContent treated every non-EXACT/missing kind as FULL and silently stripped
//            closed-schema violations. F2 (MED): deriveOperationIdentity bypassed the bound-ID contract.
import Ajv2020 from 'ajv/dist/2020';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { approvalDigest, deriveOperationIdentity, IdentityError } from '../../src/domain/identity';
import {
  decodeRevisionContent,
  normalizeRevisionContent,
  ProposalContentError,
} from '../../src/domain/proposal';
import { money } from '../../src/domain/money';
import { RevisionContentJson, revisionContentJsonSchema } from '../../src/domain/schemas';

const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(revisionContentJsonSchema() as object);

const valid = () => ({
  tenantId: 'ten_a',
  caseId: 'case_a',
  captureId: 'ABCDEFGHIJKLMNOPQ',
  amount: { kind: 'EXACT', amount: { currency: 'USD', value: '10.00' } } as Record<string, unknown>,
  reason: { code: 'GOODWILL', noteToPayer: null } as Record<string, unknown>,
  evidenceDigests: ['a'.repeat(64)],
  policyVersion: 'policy-v1',
});
const domainAccepts = (w: unknown) => {
  try {
    decodeRevisionContent(w);
    return true;
  } catch (e) {
    if (!(e instanceof ProposalContentError)) throw e; // any other error type is itself a defect
    return false;
  }
};
const verdicts = (w: unknown) => [validate(w), RevisionContentJson.safeParse(w).success, domainAccepts(w)];

describe('F1 — the domain decoder enforces the complete closed wire shape', () => {
  const usd = (value: string) => ({ currency: 'USD', value });
  const cases: Array<[string, unknown]> = [
    [
      'kind BOGUS (was accepted as FULL USD 99.00)',
      { ...valid(), amount: { kind: 'BOGUS', captureAmount: usd('99.00') } },
    ],
    ['missing kind', { ...valid(), amount: { captureAmount: usd('99.00') } }],
    ['kind null', { ...valid(), amount: { kind: null, captureAmount: usd('99.00') } }],
    ['lowercase kind', { ...valid(), amount: { kind: 'full', captureAmount: usd('99.00') } }],
    [
      'EXACT + captureAmount',
      { ...valid(), amount: { kind: 'EXACT', amount: usd('1.00'), captureAmount: usd('9.00') } },
    ],
    [
      'FULL + amount',
      { ...valid(), amount: { kind: 'FULL', captureAmount: usd('9.00'), amount: usd('1.00') } },
    ],
    ['EXACT without amount', { ...valid(), amount: { kind: 'EXACT' } }],
    ['FULL without captureAmount', { ...valid(), amount: { kind: 'FULL' } }],
    ['extra top-level field', { ...valid(), approve: true }],
    ['extra field in reason', { ...valid(), reason: { code: 'GOODWILL', noteToPayer: null, x: 1 } }],
    [
      'extra field in money',
      { ...valid(), amount: { kind: 'EXACT', amount: { currency: 'USD', value: '1.00', x: 1 } } },
    ],
    ['missing reason.noteToPayer', { ...valid(), reason: { code: 'GOODWILL' } }],
    ['missing policyVersion', (({ policyVersion: _p, ...r }) => r)(valid())],
    ['amount is an array', { ...valid(), amount: [] }],
    ['money is null', { ...valid(), amount: { kind: 'EXACT', amount: null } }],
    ['value is a number', { ...valid(), amount: { kind: 'EXACT', amount: { currency: 'USD', value: 10 } } }],
    ['evidenceDigests is a string', { ...valid(), evidenceDigests: 'a'.repeat(64) }],
    ['prototype-polluting key', JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(valid()).slice(1)}`)],
    ['null document', null],
    ['array document', []],
    ['string document', 'EXACT'],
  ];

  it.each(cases)('rejects %s — and so do Ajv and zod', (_label, w) => {
    expect(verdicts(w)).toEqual([false, false, false]);
  });

  it('accepts the valid EXACT and FULL shapes everywhere', () => {
    expect(verdicts(valid())).toEqual([true, true, true]);
    expect(verdicts({ ...valid(), amount: { kind: 'FULL', captureAmount: usd('25.00') } })).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('agrees with Ajv and zod under random structural mutations (differential)', () => {
    const keyName = fc.constantFrom(
      'x',
      'approve',
      'kind',
      'amount',
      'captureAmount',
      'value',
      'currency',
      'code',
      'tenantId',
    );
    const anyJson = fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.integer(),
      fc.string({ maxLength: 8 }),
      fc.constant({}),
      fc.constant([]),
    );
    const paths: string[][] = [[], ['amount'], ['amount', 'amount'], ['amount', 'captureAmount'], ['reason']];
    const mutation = fc.record({
      path: fc.constantFrom(...paths),
      op: fc.constantFrom('add', 'delete', 'replace', 'kind', 'flip'),
      key: keyName,
      val: anyJson,
      kind: fc.oneof(fc.constantFrom('EXACT', 'FULL', 'BOGUS', '', 'exact'), fc.string({ maxLength: 6 })),
    });
    fc.assert(
      fc.property(fc.boolean(), fc.array(mutation, { minLength: 1, maxLength: 3 }), (full, muts) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fuzzer mutates arbitrary JSON
        const doc = valid() as Record<string, any>;
        if (full) doc.amount = { kind: 'FULL', captureAmount: { currency: 'USD', value: '25.00' } };
        for (const m of muts) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fuzzer mutates arbitrary JSON
          let target: any = doc;
          for (const p of m.path) target = target && typeof target === 'object' ? target[p] : undefined;
          if (!target || typeof target !== 'object' || Array.isArray(target)) continue;
          if (m.op === 'add' || m.op === 'replace') target[m.key] = m.val;
          else if (m.op === 'delete') delete target[m.key];
          else if (m.op === 'kind' && doc.amount && typeof doc.amount === 'object') doc.amount.kind = m.kind;
          else if (m.op === 'flip' && doc.amount && typeof doc.amount === 'object')
            doc.amount =
              doc.amount.kind === 'EXACT'
                ? { ...doc.amount, kind: 'FULL' }
                : { ...doc.amount, kind: 'EXACT' };
        }
        const [a, z, d] = verdicts(doc);
        expect(d).toBe(a);
        expect(z).toBe(a);
      }),
      { numRuns: 3000 },
    );
  });
});

describe('F1 — the in-memory normalizer has no implicit FULL default either', () => {
  it('throws on an amount semantic that is neither EXACT nor FULL', () => {
    const c = {
      tenantId: 't',
      caseId: 'c',
      captureId: 'CAP',
      amount: { kind: 'BOGUS', captureAmount: money('USD', 100n) },
      reason: { code: 'GOODWILL', noteToPayer: null },
      evidenceDigests: ['a'.repeat(64)],
      policyVersion: 'p1',
    };
    expect(() => normalizeRevisionContent(c as never)).toThrow(ProposalContentError);
  });
});

describe('F2 — operation identity obeys the bound-ID contract at every entry point', () => {
  const digest = 'a'.repeat(64);
  const bad = [
    '',
    '   ',
    ' \t',
    'x\u0000',
    'ten a',
    'polé',
    '\u{1F600}',
    'x'.repeat(129),
    'x'.repeat(1_000_000),
  ];

  it.each(bad.map((b) => [JSON.stringify(b).slice(0, 24), b]))('rejects tenantId %s', (_l, t) => {
    expect(() =>
      deriveOperationIdentity({ tenantId: t, revisionId: 'rev_a', revisionDigest: digest }),
    ).toThrow(IdentityError);
  });

  it.each(bad.map((b) => [JSON.stringify(b).slice(0, 24), b]))('rejects revisionId %s', (_l, r) => {
    expect(() =>
      deriveOperationIdentity({ tenantId: 'ten_a', revisionId: r, revisionDigest: digest }),
    ).toThrow(IdentityError);
  });

  const accepts = (f: () => unknown) => {
    try {
      f();
      return true;
    } catch {
      return false;
    }
  };
  const arbId = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 140 }),
    fc.stringMatching(/^[\x21-\x7e]{0,130}$/),
    fc.constantFrom('', ' ', 'a b', 'x'.repeat(128), 'x'.repeat(129)),
  );
  const binding = {
    revisionDigest: digest,
    approverId: 'act_a',
    policyVersion: 'policy-v1',
    expiresAt: '2026-11-12T10:00:00Z',
  };
  const content = (tenantId: string) => ({
    tenantId,
    caseId: 'case_a',
    captureId: 'CAP',
    amount: { kind: 'EXACT' as const, amount: money('USD', 100n) },
    reason: { code: 'GOODWILL' as const, noteToPayer: null },
    evidenceDigests: [digest],
    policyVersion: 'policy-v1',
  });

  it('proposal, approval and operation agree on every tenant id', () => {
    fc.assert(
      fc.property(arbId, (t) => {
        const p = accepts(() => normalizeRevisionContent(content(t)));
        const a = accepts(() => approvalDigest({ ...binding, tenantId: t, revisionId: 'rev_a' }));
        const o = accepts(() =>
          deriveOperationIdentity({ tenantId: t, revisionId: 'rev_a', revisionDigest: digest }),
        );
        expect([a, o]).toEqual([p, p]);
      }),
      { numRuns: 2000 },
    );
  });

  it('approval and operation agree on every revision id', () => {
    fc.assert(
      fc.property(arbId, (r) => {
        const a = accepts(() => approvalDigest({ ...binding, tenantId: 'ten_a', revisionId: r }));
        const o = accepts(() =>
          deriveOperationIdentity({ tenantId: 'ten_a', revisionId: r, revisionDigest: digest }),
        );
        expect(o).toBe(a);
      }),
      { numRuns: 2000 },
    );
  });
});
