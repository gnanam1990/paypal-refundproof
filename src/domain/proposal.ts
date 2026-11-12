import { domainDigest, isHexDigest } from './canonical';
import { MoneyError, money, moneyFromJson, moneyToJson, type Money, type MoneyJson } from './money';

export const REFUND_REASON_CODES = [
  'DUPLICATE_CHARGE',
  'ITEM_NOT_RECEIVED',
  'ITEM_DEFECTIVE',
  'NOT_AS_DESCRIBED',
  'SERVICE_NOT_RENDERED',
  'GOODWILL',
  'OTHER',
] as const;
export type RefundReasonCode = (typeof REFUND_REASON_CODES)[number];

/**
 * Exact outbound amount semantics. EXACT sends `amount`; FULL intentionally omits it so PayPal refunds
 * "captured amount - previous refunds". FULL records the capture amount the approver saw. There is no third
 * variant: an accidentally absent amount is unrepresentable.
 */
export type AmountSemantic =
  | { readonly kind: 'EXACT'; readonly amount: Money }
  | { readonly kind: 'FULL'; readonly captureAmount: Money };

export interface RefundReason {
  readonly code: RefundReasonCode;
  readonly noteToPayer: string | null;
}

/** Every field the approval binds. Changing any of them is a different business intent. */
export interface RevisionContent {
  readonly tenantId: string;
  readonly caseId: string;
  readonly captureId: string;
  readonly amount: AmountSemantic;
  readonly reason: RefundReason;
  readonly evidenceDigests: readonly string[];
  readonly policyVersion: string;
}

export class ProposalContentError extends Error {
  override readonly name = 'ProposalContentError';
}

/** Length in Unicode code points — the unit JSON Schema `maxLength` (and the exported schema) uses. */
export const codePointLength = (s: string) => [...s].length;

export const REVISION_DIGEST_DOMAIN = 'refundproof/proposal-revision/v1';

/** Shared bound for the domain, the zod schema and the exported JSON Schema (SECURITY: bounded evidence). */
export const MAX_EVIDENCE_DIGESTS = 64;

export function amountCurrency(a: AmountSemantic) {
  return a.kind === 'EXACT' ? a.amount.currency : a.captureAmount.currency;
}

export function normalizeRevisionContent(c: RevisionContent): RevisionContent {
  const bad = (m: string) => new ProposalContentError(m);
  for (const k of ['tenantId', 'caseId', 'captureId', 'policyVersion'] as const) {
    if (typeof c[k] !== 'string' || c[k].length === 0 || codePointLength(c[k]) > 128)
      throw bad(`invalid ${k}`);
  }
  const a = c.amount;
  if (!a || (a.kind !== 'EXACT' && a.kind !== 'FULL')) throw bad('amount semantic must be EXACT or FULL');
  const raw = a.kind === 'EXACT' ? a.amount : a.captureAmount;
  let m: Money;
  try {
    m = money(raw?.currency, raw?.minor); // re-validate structurally built Money (currency table, bounds)
  } catch (e) {
    throw bad(e instanceof MoneyError ? e.message : 'invalid money');
  }
  if (m.minor <= 0n) throw bad('refund amount must be positive');
  if (!(REFUND_REASON_CODES as readonly string[]).includes(c.reason?.code)) throw bad('unknown reason code');
  const note = c.reason?.noteToPayer;
  if (note !== null && (typeof note !== 'string' || note.length === 0 || codePointLength(note) > 255)) {
    throw bad('noteToPayer must be null or 1..255 characters');
  }
  // Bound the raw input before any dedup/sort work, so an oversized list is refused, not silently shrunk.
  if (!Array.isArray(c.evidenceDigests) || c.evidenceDigests.length > MAX_EVIDENCE_DIGESTS) {
    throw bad(`at most ${MAX_EVIDENCE_DIGESTS} evidence digests`);
  }
  const evidence = [...new Set(c.evidenceDigests)].sort();
  if (evidence.length === 0 || !evidence.every(isHexDigest)) throw bad('evidence digests must be sha256 hex');
  return {
    tenantId: c.tenantId,
    caseId: c.caseId,
    captureId: c.captureId,
    amount:
      a.kind === 'EXACT'
        ? { kind: 'EXACT', amount: a.amount }
        : { kind: 'FULL', captureAmount: a.captureAmount },
    reason: { code: c.reason.code, noteToPayer: note },
    evidenceDigests: evidence,
    policyVersion: c.policyVersion,
  };
}

export interface RevisionContentWire {
  tenantId: string;
  caseId: string;
  captureId: string;
  amount: { kind: 'EXACT'; amount: MoneyJson } | { kind: 'FULL'; captureAmount: MoneyJson };
  reason: { code: RefundReasonCode; noteToPayer: string | null };
  evidenceDigests: string[];
  policyVersion: string;
}

export function encodeRevisionContent(c: RevisionContent): RevisionContentWire {
  const n = normalizeRevisionContent(c);
  return {
    tenantId: n.tenantId,
    caseId: n.caseId,
    captureId: n.captureId,
    amount:
      n.amount.kind === 'EXACT'
        ? { kind: 'EXACT', amount: moneyToJson(n.amount.amount) }
        : { kind: 'FULL', captureAmount: moneyToJson(n.amount.captureAmount) },
    reason: { code: n.reason.code, noteToPayer: n.reason.noteToPayer },
    evidenceDigests: [...n.evidenceDigests],
    policyVersion: n.policyVersion,
  };
}

export function decodeRevisionContent(w: RevisionContentWire): RevisionContent {
  return normalizeRevisionContent({
    ...w,
    amount:
      w.amount.kind === 'EXACT'
        ? { kind: 'EXACT', amount: moneyFromJson(w.amount.amount) }
        : { kind: 'FULL', captureAmount: moneyFromJson(w.amount.captureAmount) },
  });
}

export const revisionDigest = (c: RevisionContent): string =>
  domainDigest(REVISION_DIGEST_DOMAIN, encodeRevisionContent(c));

export const sameIntent = (a: RevisionContent, b: RevisionContent) => revisionDigest(a) === revisionDigest(b);
