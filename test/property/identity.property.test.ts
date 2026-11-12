import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deriveOperationIdentity, planAttempt } from '../../src/domain/identity';
import { OperationConflictError } from '../../src/domain/ledger';
import { money } from '../../src/domain/money';
import { revisionDigest, type RevisionContent } from '../../src/domain/proposal';
import { arbRevisionContent, arbRevisionId } from '../support/arbitraries';
import { MemoryOperationLedger } from '../support/memory-ledger';
import { runLedgerRace } from '../support/ledger-contract';

const ref = (tenantId: string, revisionId: string, content: RevisionContent) => ({
  tenantId,
  revisionId,
  revisionDigest: revisionDigest(content),
});

describe('T-005 — same approved revision reuses one request identity', () => {
  it('derives identical operation and PayPal request identities on every retry', () => {
    fc.assert(
      fc.property(arbRevisionContent, arbRevisionId, fc.integer({ min: 2, max: 6 }), (c, rid, retries) => {
        const ids = Array.from({ length: retries }, () => deriveOperationIdentity(ref(c.tenantId, rid, c)));
        for (const x of ids) expect(x).toEqual(ids[0]);
      }),
    );
  });

  it('keeps every attempt under the operation request identity', () => {
    fc.assert(
      fc.property(arbRevisionContent, arbRevisionId, fc.integer({ min: 0, max: 20 }), (c, rid, prior) => {
        const identity = deriveOperationIdentity(ref(c.tenantId, rid, c));
        const attempt = planAttempt(identity, prior);
        expect(attempt.paypalRequestId).toBe(identity.paypalRequestId);
        expect(attempt.operationId).toBe(identity.operationId);
        expect(attempt.attemptNo).toBe(prior + 1);
      }),
    );
  });

  it('produces PayPal-compatible identifiers', () => {
    fc.assert(
      fc.property(arbRevisionContent, arbRevisionId, (c, rid) => {
        const x = deriveOperationIdentity(ref(c.tenantId, rid, c));
        expect(x.paypalRequestId.length).toBeLessThanOrEqual(108);
        expect(x.customId).toMatch(/^[A-Za-z0-9\-_.,]{1,127}$/);
        expect(x.invoiceId.length).toBeLessThanOrEqual(127);
      }),
    );
  });

  it('races concurrent workers into exactly one operation with attempts under one request id', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRevisionContent,
        arbRevisionId,
        fc.integer({ min: 2, max: 8 }),
        fc.scheduler(),
        async (c, rid, workers, s) => {
          const ledger = new MemoryOperationLedger(s);
          const result = await runLedgerRace(ledger, ref(c.tenantId, rid, c), workers, s);
          expect(result.operations).toHaveLength(1);
          expect(result.createdCount).toBe(1);
          expect(new Set(result.attemptRequestIds)).toEqual(new Set([result.operations[0]!.paypalRequestId]));
          expect(result.attemptNumbers).toEqual(Array.from({ length: workers }, (_, i) => i + 1));
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('T-006 — a changed intent receives a new identity', () => {
  const mutations: Array<[string, (c: RevisionContent) => RevisionContent]> = [
    [
      'capture',
      (c) => ({ ...c, captureId: c.captureId === 'Z'.repeat(17) ? 'Y'.repeat(17) : 'Z'.repeat(17) }),
    ],
    [
      'amount',
      (c) =>
        c.amount.kind === 'EXACT'
          ? {
              ...c,
              amount: {
                kind: 'EXACT',
                amount: money(c.amount.amount.currency, c.amount.amount.minor === 1n ? 2n : 1n),
              },
            }
          : { ...c, amount: { kind: 'EXACT', amount: c.amount.captureAmount } },
    ],
    [
      'currency',
      (c) => {
        const a = c.amount.kind === 'EXACT' ? c.amount.amount : c.amount.captureAmount;
        const other = a.currency === 'USD' ? 'EUR' : 'USD';
        return { ...c, amount: { kind: 'EXACT', amount: money(other, 100n) } };
      },
    ],
    [
      'full-semantic',
      (c) =>
        c.amount.kind === 'FULL'
          ? { ...c, amount: { kind: 'EXACT', amount: c.amount.captureAmount } }
          : { ...c, amount: { kind: 'FULL', captureAmount: c.amount.amount } },
    ],
    [
      'reason',
      (c) => ({ ...c, reason: { ...c.reason, code: c.reason.code === 'GOODWILL' ? 'OTHER' : 'GOODWILL' } }),
    ],
    ['note', (c) => ({ ...c, reason: { ...c.reason, noteToPayer: `${c.reason.noteToPayer ?? ''}!` } })],
    ['evidence', (c) => ({ ...c, evidenceDigests: [...c.evidenceDigests, 'f'.repeat(63) + '0'] })],
    ['policy', (c) => ({ ...c, policyVersion: `${c.policyVersion}-next` })],
    ['tenant', (c) => ({ ...c, tenantId: `${c.tenantId}x` })],
    ['case', (c) => ({ ...c, caseId: `${c.caseId}x` })],
  ];

  it.each(mutations)(
    'changing %s changes the revision digest and every derived identity',
    (_name, mutate) => {
      fc.assert(
        fc.property(arbRevisionContent, arbRevisionId, (c, rid) => {
          const changed = mutate(c);
          expect(revisionDigest(changed)).not.toBe(revisionDigest(c));
          // Same revision id on both sides isolates the digest's contribution to the identity.
          const a = deriveOperationIdentity(ref(c.tenantId, rid, c));
          const b = deriveOperationIdentity(ref(changed.tenantId, rid, changed));
          expect(b.operationId).not.toBe(a.operationId);
          expect(b.paypalRequestId).not.toBe(a.paypalRequestId);
          expect(b.invoiceId).not.toBe(a.invoiceId);
        }),
      );
    },
  );

  it('gives a new revision with identical content its own identity (no reuse across approvals)', () => {
    fc.assert(
      fc.property(arbRevisionContent, arbRevisionId, arbRevisionId, (c, r1, r2) => {
        fc.pre(r1 !== r2);
        const a = deriveOperationIdentity(ref(c.tenantId, r1, c));
        const b = deriveOperationIdentity(ref(c.tenantId, r2, c));
        expect(b.paypalRequestId).not.toBe(a.paypalRequestId);
      }),
    );
  });

  it('a different digest under the same revision id and tenant yields a different request id', () => {
    fc.assert(
      fc.property(arbRevisionContent, arbRevisionContent, arbRevisionId, (c1, c2, rid) => {
        fc.pre(revisionDigest(c1) !== revisionDigest(c2));
        const a = deriveOperationIdentity({
          tenantId: 't',
          revisionId: rid,
          revisionDigest: revisionDigest(c1),
        });
        const b = deriveOperationIdentity({
          tenantId: 't',
          revisionId: rid,
          revisionDigest: revisionDigest(c2),
        });
        expect(b.paypalRequestId).not.toBe(a.paypalRequestId);
        expect(b.operationId).not.toBe(a.operationId);
      }),
    );
  });

  it('refuses an identity whose digest does not match the content it claims', () => {
    fc.assert(
      fc.property(arbRevisionContent, arbRevisionId, (c, rid) => {
        expect(() =>
          deriveOperationIdentity({ tenantId: c.tenantId, revisionId: rid, revisionDigest: 'not-a-digest' }),
        ).toThrow();
      }),
    );
  });

  it('is insensitive to evidence order and duplicates (same intent, same digest)', () => {
    fc.assert(
      fc.property(arbRevisionContent, (c) => {
        const shuffled = {
          ...c,
          evidenceDigests: [...c.evidenceDigests].reverse().concat(c.evidenceDigests[0]!),
        };
        expect(revisionDigest(shuffled)).toBe(revisionDigest(c));
      }),
    );
  });
});

describe('ledger contract — conflicting reuse of a revision id', () => {
  it('rejects the same revision id arriving with a different digest or tenant', async () => {
    const ledger = new MemoryOperationLedger();
    const d1 = 'a'.repeat(64);
    await ledger.ensureOperation({ tenantId: 't1', revisionId: 'rev_x', revisionDigest: d1 });
    await expect(
      ledger.ensureOperation({ tenantId: 't1', revisionId: 'rev_x', revisionDigest: 'b'.repeat(64) }),
    ).rejects.toThrow(OperationConflictError);
    await expect(
      ledger.ensureOperation({ tenantId: 't2', revisionId: 'rev_x', revisionDigest: d1 }),
    ).rejects.toThrow(OperationConflictError);
  });
});
