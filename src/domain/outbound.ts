import type { OperationIdentity } from './identity';
import { formatMoney, type MoneyJson, moneyToJson } from './money';
import type { RevisionContent } from './proposal';

/**
 * The exact refund request RefundProof will send, frozen before the first network attempt (TDD: "persist the
 * exact outbound payload semantics"). EXACT always carries `amount`. FULL is the only shape without `amount`,
 * and it is produced only from an approved FULL semantic — never from a missing field.
 */
export interface OutboundRefundRequest {
  captureId: string;
  semantic: 'EXACT' | 'FULL';
  /** Amount PayPal is expected to refund: the exact amount, or (FULL) the capture amount the approver saw. */
  expected: MoneyJson;
  headers: { 'PayPal-Request-Id': string; Prefer: 'return=representation' };
  body: {
    amount?: { currency_code: string; value: string };
    invoice_id: string;
    custom_id: string;
    note_to_payer?: string;
  };
}

export function buildOutboundRefund(
  content: RevisionContent,
  identity: OperationIdentity,
): OutboundRefundRequest {
  const body: OutboundRefundRequest['body'] = {
    invoice_id: identity.invoiceId,
    custom_id: identity.customId,
  };
  if (content.reason.noteToPayer) body.note_to_payer = content.reason.noteToPayer;
  let expected: MoneyJson;
  if (content.amount.kind === 'EXACT') {
    const m = content.amount.amount;
    body.amount = { currency_code: m.currency, value: formatMoney(m) };
    expected = moneyToJson(m);
  } else {
    expected = moneyToJson(content.amount.captureAmount);
  }
  return {
    captureId: content.captureId,
    semantic: content.amount.kind,
    expected,
    headers: { 'PayPal-Request-Id': identity.paypalRequestId, Prefer: 'return=representation' },
    body,
  };
}

export class OutboundMismatchError extends Error {
  override readonly name = 'OutboundMismatchError';
}

/** Re-checks a frozen request against the approved content immediately before sending (T-004). */
export function assertOutboundMatches(
  req: OutboundRefundRequest,
  content: RevisionContent,
  identity: OperationIdentity,
) {
  const fresh = buildOutboundRefund(content, identity);
  if (JSON.stringify(fresh) !== JSON.stringify(req))
    throw new OutboundMismatchError('outbound request differs from approval');
  if (req.semantic === 'EXACT' && !req.body.amount)
    throw new OutboundMismatchError('EXACT refund without amount');
  if (req.semantic === 'FULL' && req.body.amount)
    throw new OutboundMismatchError('FULL refund must omit amount');
}
