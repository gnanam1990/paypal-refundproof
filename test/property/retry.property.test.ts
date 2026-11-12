import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { backoffDelayMs, retryDecision, validateRetryPolicy } from '../../src/domain/retry';

const arbPolicy = fc
  .record({
    maxAttempts: fc.integer({ min: 1, max: 12 }),
    baseDelayMs: fc.integer({ min: 1, max: 5_000 }),
    maxDelayMs: fc.integer({ min: 1, max: 600_000 }),
    totalDeadlineMs: fc.integer({ min: 1, max: 86_400_000 }),
  })
  .filter((p) => p.maxDelayMs >= p.baseDelayMs);

describe('NFR-03 bounded retries', () => {
  it('never exceeds the delay cap and never goes negative', () => {
    fc.assert(
      fc.property(
        arbPolicy,
        fc.integer({ min: 1, max: 200 }),
        fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }),
        (p, n, r) => {
          const d = backoffDelayMs(p, n, () => r);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(p.maxDelayMs);
        },
      ),
    );
  });

  it('reaches an explicit EXHAUSTED decision at the attempt bound or deadline', () => {
    fc.assert(
      fc.property(arbPolicy, fc.integer({ min: 0, max: 1_000_000 }), (p, start) => {
        expect(retryDecision(p, { attemptNo: p.maxAttempts, startedAtMs: start, nowMs: start }).kind).toBe(
          'EXHAUSTED',
        );
        expect(
          retryDecision(p, { attemptNo: 1, startedAtMs: start, nowMs: start + p.totalDeadlineMs }).kind,
        ).toBe('EXHAUSTED');
      }),
    );
  });

  it('never schedules a retry beyond the total deadline', () => {
    fc.assert(
      fc.property(
        arbPolicy,
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 86_400_000 }),
        (p, n, elapsed) => {
          const d = retryDecision(p, { attemptNo: n, startedAtMs: 0, nowMs: elapsed }, () => 0.999);
          if (d.kind === 'RETRY') expect(elapsed + d.delayMs).toBeLessThanOrEqual(p.totalDeadlineMs);
        },
      ),
    );
  });

  it('rejects unbounded policies', () => {
    expect(() =>
      validateRetryPolicy({ maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1, totalDeadlineMs: 1 }),
    ).toThrow();
    expect(() =>
      validateRetryPolicy({
        maxAttempts: Number.POSITIVE_INFINITY,
        baseDelayMs: 1,
        maxDelayMs: 1,
        totalDeadlineMs: 1,
      }),
    ).toThrow();
    expect(() =>
      validateRetryPolicy({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 5, totalDeadlineMs: 1 }),
    ).toThrow();
  });
});
