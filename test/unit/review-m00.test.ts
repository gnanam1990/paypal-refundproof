import { describe, expect, it } from 'vitest';
import { approvalDigest } from '../../src/domain/identity';
import { revisionDigest, ProposalContentError, type RevisionContent } from '../../src/domain/proposal';
import { RetryPolicyError, retryDecision, validateRetryPolicy } from '../../src/domain/retry';
import { InvalidTransitionError, assertOperationTransition } from '../../src/domain/states';
import { revisionContentJsonSchema } from '../../src/domain/schemas';
import type { Money } from '../../src/domain/money';

const base: RevisionContent = {
  tenantId: 't',
  caseId: 'c',
  captureId: 'CAP',
  amount: { kind: 'EXACT', amount: { currency: 'USD', minor: 100n } },
  reason: { code: 'GOODWILL', noteToPayer: null },
  evidenceDigests: ['a'.repeat(64)],
  policyVersion: 'p1',
};

describe('kernel validation (M00 review findings)', () => {
  it('rejects hand-built money that bypasses money()', () => {
    const bad = (m: Money) => () => revisionDigest({ ...base, amount: { kind: 'EXACT', amount: m } });
    expect(bad({ currency: 'XXX' as never, minor: 1n })).toThrow(ProposalContentError);
    expect(bad({ currency: 'USD', minor: 10n ** 30n })).toThrow(ProposalContentError);
  });

  it('rejects an unknown reason code in the digest path', () => {
    expect(() => revisionDigest({ ...base, reason: { code: 'BOGUS' as never, noteToPayer: null } })).toThrow(
      ProposalContentError,
    );
  });

  it('approval digest refuses offset-less or non-ISO instants and ignores extra properties', () => {
    const b = {
      tenantId: 't',
      revisionId: 'r',
      revisionDigest: 'a'.repeat(64),
      approverId: 'u',
      policyVersion: 'p1',
    };
    expect(() => approvalDigest({ ...b, expiresAt: '2026-11-12T10:00:00' })).toThrow();
    expect(() => approvalDigest({ ...b, expiresAt: 'Thu, 12 Nov 2026 10:00:00 GMT' })).toThrow();
    const d = approvalDigest({ ...b, expiresAt: '2026-11-12T10:00:00.000Z' });
    expect(approvalDigest({ ...b, expiresAt: '2026-11-12T10:00:00.000Z', extra: 'x' } as never)).toBe(d);
  });
});

describe('evidence-gated operation edges (M00 review finding)', () => {
  it.each([
    ['SUBMITTING', 'READY'],
    ['SUBMITTING', 'CANCELLED_BEFORE_DISPATCH'],
    ['READY', 'CANCELLED_BEFORE_DISPATCH'],
    ['SUBMITTING', 'PROVIDER_TERMINAL_NOT_APPLIED'],
    ['RECONCILING', 'PROVIDER_TERMINAL_NOT_APPLIED'],
    ['SUBMITTING', 'CONFIRMED'],
    ['RECONCILING', 'CONFIRMED'],
    ['SUBMITTING', 'RECONCILING'],
  ] as const)('%s -> %s requires declared evidence', (from, to) => {
    expect(() => assertOperationTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it('rejects the wrong kind of evidence', () => {
    expect(() => assertOperationTransition('SUBMITTING', 'READY', 'NEVER_DISPATCHED')).toThrow(
      InvalidTransitionError,
    );
    expect(() =>
      assertOperationTransition('RECONCILING', 'CONFIRMED', 'PROVIDER_TERMINAL_OBSERVATION'),
    ).toThrow(InvalidTransitionError);
    expect(() => assertOperationTransition('SUBMITTING', 'READY', 'NOT_SENT')).not.toThrow();
    expect(() =>
      assertOperationTransition('RECONCILING', 'CONFIRMED', 'PROVIDER_CONFIRMED_OBSERVATION'),
    ).not.toThrow();
  });
});

describe('retry hardening (M00 review finding)', () => {
  const p = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, totalDeadlineMs: 10_000 };
  it('rejects non-finite inputs and an excessive attempt bound', () => {
    expect(() => retryDecision(p, { attemptNo: 1, startedAtMs: 0, nowMs: Number.NaN })).toThrow(
      RetryPolicyError,
    );
    expect(() => retryDecision(p, { attemptNo: 1.5, startedAtMs: 0, nowMs: 0 })).toThrow(RetryPolicyError);
    expect(() => retryDecision(p, { attemptNo: 1, startedAtMs: 0, nowMs: 0 }, () => Number.NaN)).toThrow(
      RetryPolicyError,
    );
    expect(() => validateRetryPolicy({ ...p, maxAttempts: 10_000 })).toThrow(RetryPolicyError);
  });
  it('is exhausted rather than retrying at the deadline instant', () => {
    expect(retryDecision(p, { attemptNo: 1, startedAtMs: 0, nowMs: 9_990 }, () => 0.5).kind).toBe(
      'EXHAUSTED',
    );
  });
});

describe('exported JSON schema keeps the money format', () => {
  it('carries a decimal pattern on money values', () => {
    expect(JSON.stringify(revisionContentJsonSchema())).toContain('"pattern"');
  });
});
