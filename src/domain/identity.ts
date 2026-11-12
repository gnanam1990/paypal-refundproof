import { domainDigest, isHexDigest } from './canonical';

/** The approved revision an effectful operation belongs to. One approved revision ↔ one operation. */
export interface ApprovedRevisionRef {
  readonly tenantId: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
}

export interface OperationIdentity {
  readonly operationId: string;
  /** Sent as PayPal-Request-Id on every attempt of this operation; immutable once allocated. */
  readonly paypalRequestId: string;
  /** Sent as the refund invoice_id; used to find our refund in order details during reconciliation. */
  readonly invoiceId: string;
  /** Sent as the refund custom_id (PayPal pattern ^[A-Za-z0-9-_.,]*$). */
  readonly customId: string;
}

export interface ProviderAttemptPlan {
  readonly operationId: string;
  readonly attemptNo: number;
  readonly paypalRequestId: string;
}

export class IdentityError extends Error {
  override readonly name = 'IdentityError';
}

const OPERATION_DOMAIN = 'refundproof/refund-operation/v1';

/**
 * Pure, database-independent derivation. Two workers handling the same approved revision compute the same
 * identity; any other revision (even with identical content) computes a different one, because the
 * server-generated revision id is part of the input.
 */
export function deriveOperationIdentity(ref: ApprovedRevisionRef): OperationIdentity {
  if (!ref.tenantId || !ref.revisionId) throw new IdentityError('tenant and revision ids are required');
  if (!isHexDigest(ref.revisionDigest)) throw new IdentityError('revision digest must be sha256 hex');
  const d = domainDigest(OPERATION_DOMAIN, {
    tenantId: ref.tenantId,
    revisionId: ref.revisionId,
    revisionDigest: ref.revisionDigest,
  });
  return Object.freeze({
    operationId: `op_${d.slice(0, 32)}`,
    paypalRequestId: `refundproof-${d}`,
    invoiceId: `RP-${d.slice(0, 24).toUpperCase()}`,
    customId: `rp_op_${d.slice(0, 32)}`,
  });
}

/** A retry is an attempt within the operation: same request id, next attempt number. */
export function planAttempt(identity: OperationIdentity, priorAttempts: number): ProviderAttemptPlan {
  if (!Number.isInteger(priorAttempts) || priorAttempts < 0) throw new IdentityError('invalid attempt count');
  return Object.freeze({
    operationId: identity.operationId,
    attemptNo: priorAttempts + 1,
    paypalRequestId: identity.paypalRequestId,
  });
}

export interface ApprovalBinding {
  readonly tenantId: string;
  readonly revisionId: string;
  readonly revisionDigest: string;
  readonly approverId: string;
  readonly policyVersion: string;
  /** ISO-8601 UTC instant. */
  readonly expiresAt: string;
}

const APPROVAL_DOMAIN = 'refundproof/approval/v1';
/** Bound identifiers are server-generated: printable ASCII, no whitespace or control characters, 1..128. */
const BOUND_ID = /^[\x21-\x7e]{1,128}$/;
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Accepts only a real calendar instant: `Date.parse` silently rolls 2026-02-30 over to March 2, so every
 * component is round-tripped through UTC and must come back unchanged.
 */
export function assertRealUtcInstant(s: string): void {
  const m = typeof s === 'string' ? UTC_INSTANT.exec(s) : null;
  if (!m) throw new IdentityError('expiresAt must be a UTC ISO-8601 instant ending in Z');
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Number((m[7] ?? '0').padEnd(3, '0'));
  if (y < 1970) throw new IdentityError('expiresAt year out of range');
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se, ms));
  const same =
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === se;
  if (!same) throw new IdentityError(`expiresAt ${s} is not a real calendar instant`);
}

/** Digest the approval binds; the revision digest already covers capture, amount/semantic, currency and reason. */
export function approvalDigest(b: ApprovalBinding): string {
  if (!isHexDigest(b.revisionDigest)) throw new IdentityError('revision digest must be sha256 hex');
  for (const k of ['tenantId', 'revisionId', 'approverId', 'policyVersion'] as const) {
    if (typeof b[k] !== 'string' || !BOUND_ID.test(b[k])) {
      throw new IdentityError(`${k} must be 1..128 printable ASCII characters without whitespace`);
    }
  }
  assertRealUtcInstant(b.expiresAt);
  return domainDigest(APPROVAL_DOMAIN, {
    tenantId: b.tenantId,
    revisionId: b.revisionId,
    revisionDigest: b.revisionDigest,
    approverId: b.approverId,
    policyVersion: b.policyVersion,
    expiresAt: new Date(b.expiresAt).toISOString(),
  });
}
