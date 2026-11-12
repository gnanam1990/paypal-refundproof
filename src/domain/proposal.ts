import { isBoundId } from './bound-id';
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
    if (!isBoundId(c[k])) throw bad(`invalid ${k}: 1..128 printable ASCII characters without whitespace`);
  }
  const a = c.amount;
  let raw: Money | undefined;
  const kind = (a as { kind?: unknown } | undefined)?.kind;
  switch (kind) {
    case 'EXACT':
      raw = (a as Extract<AmountSemantic, { kind: 'EXACT' }>).amount;
      break;
    case 'FULL':
      raw = (a as Extract<AmountSemantic, { kind: 'FULL' }>).captureAmount;
      break;
    default:
      throw bad('amount semantic must be exactly EXACT or FULL');
  }
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
    amount: kind === 'EXACT' ? { kind: 'EXACT', amount: m } : { kind: 'FULL', captureAmount: m },
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

function encodeAmount(a: AmountSemantic): RevisionContentWire['amount'] {
  switch (a.kind) {
    case 'EXACT':
      return { kind: 'EXACT', amount: moneyToJson(a.amount) };
    case 'FULL':
      return { kind: 'FULL', captureAmount: moneyToJson(a.captureAmount) };
    default: {
      const unreachable: never = a;
      throw new ProposalContentError(`unknown amount semantic ${JSON.stringify(unreachable)}`);
    }
  }
}

export function encodeRevisionContent(c: RevisionContent): RevisionContentWire {
  const n = normalizeRevisionContent(c);
  return {
    tenantId: n.tenantId,
    caseId: n.caseId,
    captureId: n.captureId,
    amount: encodeAmount(n.amount),
    reason: { code: n.reason.code, noteToPayer: n.reason.noteToPayer },
    evidenceDigests: [...n.evidenceDigests],
    policyVersion: n.policyVersion,
  };
}

// ------------------------------------------------------------------------------------------ closed wire decoding

type WireObject = Record<string, unknown>;
const TOP_LEVEL_KEYS = [
  'tenantId',
  'caseId',
  'captureId',
  'amount',
  'reason',
  'evidenceDigests',
  'policyVersion',
];

function isPlainObject(v: unknown): v is WireObject {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Exactly these keys, all present, nothing else (own keys only, so a JSON `__proto__` key is "unknown"). */
function closedObject(v: unknown, keys: readonly string[], where: string): WireObject {
  if (!isPlainObject(v)) throw new ProposalContentError(`${where} must be an object`);
  for (const k of Object.keys(v)) {
    if (!keys.includes(k)) throw new ProposalContentError(`${where} has unknown field "${k.slice(0, 32)}"`);
  }
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(v, k))
      throw new ProposalContentError(`${where} is missing ${k}`);
  }
  return v;
}

function decodeMoneyWire(v: unknown, where: string): Money {
  const o = closedObject(v, ['currency', 'value'], where);
  if (typeof o.currency !== 'string' || typeof o.value !== 'string') {
    throw new ProposalContentError(`${where} currency and value must be strings`);
  }
  try {
    return moneyFromJson({ currency: o.currency, value: o.value });
  } catch (e) {
    throw new ProposalContentError(`${where}: ${e instanceof MoneyError ? e.message : 'invalid money'}`);
  }
}

function decodeAmountWire(v: unknown): AmountSemantic {
  if (!isPlainObject(v)) throw new ProposalContentError('amount must be an object');
  const kind = v.kind;
  switch (kind) {
    case 'EXACT':
      closedObject(v, ['kind', 'amount'], 'amount');
      return { kind: 'EXACT', amount: decodeMoneyWire(v.amount, 'amount.amount') };
    case 'FULL':
      closedObject(v, ['kind', 'captureAmount'], 'amount');
      return { kind: 'FULL', captureAmount: decodeMoneyWire(v.captureAmount, 'amount.captureAmount') };
    default:
      // No implicit default: an unknown or missing kind is never a FULL refund.
      throw new ProposalContentError('amount.kind must be exactly "EXACT" or "FULL"');
  }
}

/**
 * Decodes untrusted wire content (stored JSON, API input) and enforces the same closed shape as the exported
 * JSON Schema: exact key sets at every level, typed leaves, exhaustive amount kinds. It never strips or
 * coerces — anything the schema would reject is a ProposalContentError.
 */
export function decodeRevisionContent(w: unknown): RevisionContent {
  const o = closedObject(w, TOP_LEVEL_KEYS, 'revision content');
  const reason = closedObject(o.reason, ['code', 'noteToPayer'], 'reason');
  if (typeof reason.code !== 'string') throw new ProposalContentError('reason.code must be a string');
  if (reason.noteToPayer !== null && typeof reason.noteToPayer !== 'string') {
    throw new ProposalContentError('reason.noteToPayer must be a string or null');
  }
  for (const k of ['tenantId', 'caseId', 'captureId', 'policyVersion'] as const) {
    if (typeof o[k] !== 'string') throw new ProposalContentError(`${k} must be a string`);
  }
  if (!Array.isArray(o.evidenceDigests) || !o.evidenceDigests.every((d) => typeof d === 'string')) {
    throw new ProposalContentError('evidenceDigests must be an array of strings');
  }
  return normalizeRevisionContent({
    tenantId: o.tenantId as string,
    caseId: o.caseId as string,
    captureId: o.captureId as string,
    amount: decodeAmountWire(o.amount),
    reason: { code: reason.code as RefundReasonCode, noteToPayer: reason.noteToPayer as string | null },
    evidenceDigests: o.evidenceDigests as string[],
    policyVersion: o.policyVersion as string,
  });
}

export const revisionDigest = (c: RevisionContent): string =>
  domainDigest(REVISION_DIGEST_DOMAIN, encodeRevisionContent(c));

export const sameIntent = (a: RevisionContent, b: RevisionContent) => revisionDigest(a) === revisionDigest(b);
