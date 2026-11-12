/** NFR-03: every external interaction runs under a finite attempt bound and a finite total deadline. */
export interface BoundedRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly totalDeadlineMs: number;
}

export const MAX_ATTEMPTS_CEILING = 100;

export class RetryPolicyError extends Error {
  override readonly name = 'RetryPolicyError';
}

export function validateRetryPolicy(p: BoundedRetryPolicy): BoundedRetryPolicy {
  const finitePos = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (!finitePos(p.maxAttempts) || p.maxAttempts > MAX_ATTEMPTS_CEILING) {
    throw new RetryPolicyError(`maxAttempts must be an integer in 1..${MAX_ATTEMPTS_CEILING}`);
  }
  if (!finitePos(p.baseDelayMs) || !finitePos(p.maxDelayMs))
    throw new RetryPolicyError('delays must be positive');
  if (p.maxDelayMs < p.baseDelayMs) throw new RetryPolicyError('maxDelayMs must be >= baseDelayMs');
  if (!finitePos(p.totalDeadlineMs)) throw new RetryPolicyError('totalDeadlineMs must be finite');
  return p;
}

/** Capped exponential backoff with full jitter: uniform in [0, min(max, base * 2^(n-1))]. */
export function backoffDelayMs(
  p: BoundedRetryPolicy,
  attemptNo: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(30, Math.max(0, attemptNo - 1));
  const ceiling = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** exp);
  const raw = random();
  if (!Number.isFinite(raw)) throw new RetryPolicyError('random source returned a non-finite value');
  const r = Math.min(Math.max(raw, 0), 1);
  return Math.floor(ceiling * r);
}

export type RetryDecision =
  { kind: 'RETRY'; delayMs: number } | { kind: 'EXHAUSTED'; reason: 'MAX_ATTEMPTS' | 'DEADLINE' };

/** Decide after `attemptNo` attempts have been made, starting at startedAtMs. */
export function retryDecision(
  p: BoundedRetryPolicy,
  at: { attemptNo: number; startedAtMs: number; nowMs: number },
  random: () => number = Math.random,
): RetryDecision {
  validateRetryPolicy(p);
  if (!Number.isSafeInteger(at.attemptNo) || at.attemptNo < 0)
    throw new RetryPolicyError('attemptNo must be an integer');
  if (!Number.isFinite(at.startedAtMs) || !Number.isFinite(at.nowMs))
    throw new RetryPolicyError('times must be finite');
  if (at.attemptNo >= p.maxAttempts) return { kind: 'EXHAUSTED', reason: 'MAX_ATTEMPTS' };
  const remaining = at.startedAtMs + p.totalDeadlineMs - at.nowMs;
  if (remaining <= 0) return { kind: 'EXHAUSTED', reason: 'DEADLINE' };
  const delayMs = backoffDelayMs(p, at.attemptNo, random);
  // The next attempt must start strictly before the deadline.
  if (delayMs >= remaining) return { kind: 'EXHAUSTED', reason: 'DEADLINE' };
  return { kind: 'RETRY', delayMs };
}
