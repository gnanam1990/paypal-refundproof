import { describe, expect, it } from 'vitest';
import type { OperationIdentity } from '../../src/domain/identity';
import { buildOutboundRefund, assertOutboundMatches, OutboundMismatchError } from '../../src/domain/outbound';
import type { RevisionContent } from '../../src/domain/proposal';

const content: RevisionContent = {
  tenantId: 'tenant_demo',
  caseId: 'case_demo',
  captureId: 'CAPTURE-DEMO',
  amount: { kind: 'EXACT', amount: { currency: 'USD', minor: 8400n } },
  reason: { code: 'DUPLICATE_CHARGE', noteToPayer: 'Verified duplicate charge.' },
  evidenceDigests: ['a'.repeat(64)],
  policyVersion: 'refund-v1',
};

const identity: OperationIdentity = {
  operationId: 'op_demo',
  paypalRequestId: `refundproof-${'b'.repeat(64)}`,
  invoiceId: 'RP-DEMO',
  customId: 'rp_op_demo',
};

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
  );
}

describe('outbound approval binding', () => {
  it('accepts the same frozen request after jsonb reorders object keys', () => {
    const outbound = buildOutboundRefund(content, identity);
    const reordered = reverseObjectKeys(outbound) as typeof outbound;

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(outbound));
    expect(() => assertOutboundMatches(reordered, content, identity)).not.toThrow();
  });

  it('still rejects a semantic payload change', () => {
    const outbound = buildOutboundRefund(content, identity);
    const changed = {
      ...outbound,
      body: { ...outbound.body, amount: { currency_code: 'USD', value: '83.00' } },
    };

    expect(() => assertOutboundMatches(changed, content, identity)).toThrow(OutboundMismatchError);
  });
});
