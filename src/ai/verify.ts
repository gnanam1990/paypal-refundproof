import { compareMoney, MoneyError, parseMoney, type Money } from '../domain/money';
import type { AmountSemantic, RefundReasonCode } from '../domain/proposal';
import type { AdmittedEvidence } from './prompt';
import { ProposalOutput, REQUIRED_CLAIMS, type Claim } from './schema';

export interface VerifiedCitation {
  claim: Claim;
  label: string;
  evidenceId: string | null;
  quote: string;
  start: number | null;
  end: number | null;
  verified: boolean;
  failure: string | null;
}

export interface CaptureFacts {
  captureId: string;
  status: string;
  amount: Money;
}

export type Verification =
  | {
      ok: true;
      output: ProposalOutput;
      amount: AmountSemantic;
      reasonCode: RefundReasonCode;
      noteToPayer: string | null;
      citations: VerifiedCitation[];
      correctionReasons: string[];
    }
  | { ok: false; errors: string[]; output: unknown };

/** Capture states that can still be refunded (PayPal capture status enum). */
const REFUNDABLE = new Set(['COMPLETED', 'PARTIALLY_REFUNDED']);

/** Instruction-like text in untrusted evidence: never obeyed, always surfaced for a human. */
const INJECTION =
  /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|rules|messages)|disregard (?:the|your) (?:instructions|rules)|system prompt|you are now|as an ai|approve (?:this|the|my) refund|execute (?:the|a) refund|call (?:the )?paypal|<\/?(?:system|assistant|instructions?)\b|\bassistant:/i;

export const looksLikeInjection = (text: string) => INJECTION.test(text);

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const ONLY_PLACEHOLDERS = /^(?:\s|\[REDACTED:[A-Z]+\]|[.,;:!?-])*$/;

/**
 * Validates untrusted model text against the closed schema, the capture, and the admitted evidence. A schema or
 * money violation rejects the output entirely; unsupported or uncertain content yields a draft that requires
 * human correction (DB-enforced: a revision with correction reasons cannot leave DRAFT).
 */
export function verifyProposal(
  text: string,
  capture: CaptureFacts,
  evidence: AdmittedEvidence[],
): Verification {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['output is not JSON'], output: null };
  }
  const parsed = ProposalOutput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      output: raw,
    };
  }
  const out = parsed.data;
  const reasons = new Set<string>();

  let amount: AmountSemantic;
  if (out.amount.kind === 'EXACT') {
    let m: Money;
    try {
      m = parseMoney(out.amount.amount.value, out.amount.amount.currency);
    } catch (e) {
      return {
        ok: false,
        errors: [`amount: ${e instanceof MoneyError ? e.message : 'invalid money'}`],
        output: raw,
      };
    }
    if (m.minor === 0n) return { ok: false, errors: ['amount: must be positive'], output: raw };
    if (m.currency !== capture.amount.currency) {
      return {
        ok: false,
        errors: [`amount: currency ${m.currency} differs from capture ${capture.amount.currency}`],
        output: raw,
      };
    }
    if (compareMoney(m, capture.amount) > 0) reasons.add('AMOUNT_EXCEEDS_CAPTURE');
    amount = { kind: 'EXACT', amount: m };
  } else {
    amount = { kind: 'FULL', captureAmount: capture.amount };
    reasons.add('FULL_REFUND_REQUESTED');
  }

  if (out.captureId !== capture.captureId) reasons.add('CAPTURE_MISMATCH');
  if (!REFUNDABLE.has(capture.status)) reasons.add('CAPTURE_NOT_REFUNDABLE');

  const byLabel = new Map(evidence.map((e) => [e.label, e]));
  const citations: VerifiedCitation[] = out.citations.map((c) => {
    const e = byLabel.get(c.evidence);
    const quote = unescape(c.quote);
    const fail = (failure: string): VerifiedCitation => ({
      claim: c.claim,
      label: c.evidence,
      evidenceId: null,
      quote: c.quote,
      start: null,
      end: null,
      verified: false,
      failure,
    });
    if (!e) return fail('cites evidence that was not admitted');
    if (ONLY_PLACEHOLDERS.test(quote)) return fail('quote contains no evidence text');
    const start = e.redactedText.indexOf(quote);
    if (start < 0) return fail('quote is not an exact substring of the cited evidence');
    return {
      claim: c.claim,
      label: c.evidence,
      evidenceId: e.evidenceId,
      quote,
      start,
      end: start + quote.length,
      verified: true,
      failure: null,
    };
  });
  if (citations.some((c) => !c.verified)) reasons.add('INVALID_CITATION');
  const supported = new Set(citations.filter((c) => c.verified).map((c) => c.claim));
  for (const claim of REQUIRED_CLAIMS) if (!supported.has(claim)) reasons.add(`UNCITED_${claim}`);
  if (out.noteToPayer !== null && !supported.has('NOTE_TO_PAYER')) reasons.add('UNCITED_NOTE_TO_PAYER');
  for (const u of out.uncertainties) reasons.add(`MODEL_UNCERTAIN_${u.field}`);
  if (evidence.some((e) => looksLikeInjection(e.redactedText))) reasons.add('INSTRUCTION_IN_EVIDENCE');

  return {
    ok: true,
    output: out,
    amount,
    reasonCode: out.reasonCode,
    noteToPayer: out.noteToPayer,
    citations,
    correctionReasons: [...reasons].sort(),
  };
}
