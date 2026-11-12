import type { RefundExchange } from './client';

export type ObservationClass =
  | 'REFUND_COMPLETED'
  | 'REFUND_PENDING'
  | 'REFUND_TERMINAL_NOT_APPLIED'
  | 'REQUEST_REJECTED_TERMINAL'
  | 'NOT_PROCESSED_RETRYABLE'
  | 'AMBIGUOUS';

export interface Classified {
  classification: ObservationClass;
  refundId: string | null;
  refundStatus: string | null;
}

/**
 * DR-0001 classification of one refund exchange. Only a parsed PayPal answer can be terminal; anything else
 * (409 in progress, 5xx, timeout, reset, unparseable) is AMBIGUOUS and must be reconciled.
 */
export function classifyRefund(x: RefundExchange): Classified {
  if (x.kind === 'UNKNOWN') return { classification: 'AMBIGUOUS', refundId: null, refundStatus: null };
  const b = (x.body ?? {}) as { id?: string; status?: string };
  if (x.httpStatus === 200 || x.httpStatus === 201) {
    const status = typeof b.status === 'string' ? b.status : null;
    const refundId = typeof b.id === 'string' ? b.id : null;
    if (status === 'COMPLETED') return { classification: 'REFUND_COMPLETED', refundId, refundStatus: status };
    if (status === 'PENDING') return { classification: 'REFUND_PENDING', refundId, refundStatus: status };
    if (status === 'FAILED' || status === 'CANCELLED')
      return { classification: 'REFUND_TERMINAL_NOT_APPLIED', refundId, refundStatus: status };
    return { classification: 'AMBIGUOUS', refundId, refundStatus: status };
  }
  if ([400, 403, 404, 422].includes(x.httpStatus))
    return { classification: 'REQUEST_REJECTED_TERMINAL', refundId: null, refundStatus: null };
  if (x.httpStatus === 401 || x.httpStatus === 429)
    return { classification: 'NOT_PROCESSED_RETRYABLE', refundId: null, refundStatus: null };
  return { classification: 'AMBIGUOUS', refundId: null, refundStatus: null };
}

/** A reconciliation match on the order's refunds (by this operation's own invoice_id and custom_id). */
export function classifyLookup(status: string | null): ObservationClass | 'MATCH_ABSENT' {
  if (status === null) return 'MATCH_ABSENT';
  if (status === 'COMPLETED') return 'REFUND_COMPLETED';
  if (status === 'PENDING') return 'REFUND_PENDING';
  if (status === 'FAILED' || status === 'CANCELLED') return 'REFUND_TERMINAL_NOT_APPLIED';
  return 'AMBIGUOUS';
}
