// Corrective round 2 — gaps surfaced by the independent re-review of PR #2 (head a45b6e6).
import Ajv2020 from 'ajv/dist/2020';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { approvalDigest, IdentityError } from '../../src/domain/identity';
import { decodeRevisionContent, type RevisionContentWire } from '../../src/domain/proposal';
import { RevisionContentJson, revisionContentJsonSchema } from '../../src/domain/schemas';

const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile(revisionContentJsonSchema() as object);
const binding = {
  tenantId: 'ten_a',
  revisionId: 'rev_a',
  revisionDigest: 'a'.repeat(64),
  approverId: 'act_a',
  policyVersion: 'policy-v1',
  expiresAt: '2026-11-12T10:00:00Z',
};
const wire = (over: Partial<RevisionContentWire> = {}): RevisionContentWire => ({
  tenantId: 'ten_a',
  caseId: 'case_a',
  captureId: 'ABCDEFGHIJKLMNOPQ',
  amount: { kind: 'EXACT', amount: { currency: 'USD', value: '10.00' } },
  reason: { code: 'GOODWILL', noteToPayer: null },
  evidenceDigests: ['a'.repeat(64)],
  policyVersion: 'policy-v1',
  ...over,
});
const domainAccepts = (w: unknown) => {
  try {
    decodeRevisionContent(w as RevisionContentWire);
    return true;
  } catch {
    return false;
  }
};

describe('R2-1 (INV-01) — an approval digest is bound to the exact revision id', () => {
  it('changes when only the revision id changes (identical content digest)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^rev_[a-z0-9]{4,12}$/),
        fc.stringMatching(/^rev_[a-z0-9]{4,12}$/),
        (r1, r2) => {
          fc.pre(r1 !== r2);
          expect(approvalDigest({ ...binding, revisionId: r1 })).not.toBe(
            approvalDigest({ ...binding, revisionId: r2 }),
          );
        },
      ),
    );
  });

  it.each(['tenantId', 'revisionDigest', 'approverId', 'policyVersion', 'expiresAt'] as const)(
    'changes when only %s changes',
    (k) => {
      const changed =
        k === 'revisionDigest'
          ? 'b'.repeat(64)
          : k === 'expiresAt'
            ? '2026-11-12T10:00:01Z'
            : `${binding[k]}x`;
      expect(approvalDigest({ ...binding, [k]: changed })).not.toBe(approvalDigest(binding));
    },
  );
});

describe('R2-2 — bound identifiers are printable, without whitespace or control characters', () => {
  it.each([' ', '\u0000', 'act a', 'act\n', '\tact', 'act\u007f', 'act '])(
    'rejects %j as an approver id',
    (id) => {
      expect(() => approvalDigest({ ...binding, approverId: id })).toThrow(IdentityError);
    },
  );
});

describe('R2-3 — schema and domain measure string length identically', () => {
  it('agrees on identifiers and notes containing astral (surrogate-pair) characters', () => {
    const arbText = fc.string({ unit: 'binary', minLength: 1, maxLength: 300 });
    fc.assert(
      fc.property(arbText, arbText, (id, note) => {
        const doc = wire({ caseId: id, reason: { code: 'GOODWILL', noteToPayer: note } });
        const verdicts = [validate(doc), RevisionContentJson.safeParse(doc).success, domainAccepts(doc)];
        expect(new Set(verdicts).size).toBe(1);
      }),
      { numRuns: 1500 },
    );
  });

  it('treats 65 emoji (130 UTF-16 units) the same everywhere', () => {
    const doc = wire({ caseId: '\u{1F600}'.repeat(65) });
    expect(validate(doc)).toBe(domainAccepts(doc));
    expect(RevisionContentJson.safeParse(doc).success).toBe(domainAccepts(doc));
  });
});

describe('R2-4 — exported patterns stay within the portable ECMA-262 subset', () => {
  it('uses no lookaround, so RE2-based validators accept the schema', () => {
    const s = JSON.stringify(revisionContentJsonSchema());
    expect(s).not.toMatch(/\(\?[=!<]/);
  });
});

describe('R3 — content identifiers obey the same rule the approval binds; note length in code points', () => {
  it.each(['tenantId', 'caseId', 'captureId', 'policyVersion'] as const)(
    'rejects a whitespace or non-ASCII %s in schema, zod and domain alike',
    (k) => {
      for (const bad of ['ten a', 'polé', '\u{1F600}', 'x\u0000']) {
        const doc = wire({ [k]: bad } as Partial<RevisionContentWire>);
        expect([validate(doc), RevisionContentJson.safeParse(doc).success, domainAccepts(doc)]).toEqual([
          false,
          false,
          false,
        ]);
      }
    },
  );

  it('accepts content whose bound ids are exactly what approvalDigest accepts', () => {
    const doc = wire({ tenantId: '~'.repeat(128), policyVersion: 'policy-v1' });
    expect([validate(doc), RevisionContentJson.safeParse(doc).success, domainAccepts(doc)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(() => approvalDigest({ ...binding, tenantId: '~'.repeat(128) })).not.toThrow();
  });

  it('measures noteToPayer in code points: 255 emoji accepted, 256 rejected everywhere', () => {
    const at = (n: number) => wire({ reason: { code: 'GOODWILL', noteToPayer: '\u{1F600}'.repeat(n) } });
    expect([
      validate(at(255)),
      RevisionContentJson.safeParse(at(255)).success,
      domainAccepts(at(255)),
    ]).toEqual([true, true, true]);
    expect([
      validate(at(256)),
      RevisionContentJson.safeParse(at(256)).success,
      domainAccepts(at(256)),
    ]).toEqual([false, false, false]);
  });
});
