import { z } from 'zod';
import { REFUND_REASON_CODES } from '../domain/proposal';

/**
 * The only shape a model may return. Every object is closed (strictObject). There is no field for approval,
 * execution, a refund id, tools, or free-form actions: the model proposes; people approve; the worker executes.
 */
export const CLAIMS = ['AMOUNT', 'REASON', 'CAPTURE_MATCH', 'NOTE_TO_PAYER'] as const;
export type Claim = (typeof CLAIMS)[number];

/** Claims every proposal must support with at least one verified citation. */
export const REQUIRED_CLAIMS: readonly Claim[] = ['AMOUNT', 'REASON', 'CAPTURE_MATCH'];

const MoneyOut = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  value: z.string().regex(/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,3})?$/),
});

export const ProposalOutput = z.strictObject({
  captureId: z.string().min(1).max(64),
  amount: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('EXACT'), amount: MoneyOut }),
    z.strictObject({ kind: z.literal('FULL') }),
  ]),
  reasonCode: z.enum(REFUND_REASON_CODES),
  noteToPayer: z.string().min(1).max(255).nullable(),
  rationale: z.string().min(1).max(1000),
  citations: z
    .array(
      z.strictObject({
        claim: z.enum(CLAIMS),
        evidence: z.string().regex(/^E[0-9]{1,3}$/),
        quote: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(16),
  uncertainties: z.array(z.strictObject({ field: z.enum(CLAIMS), note: z.string().min(1).max(300) })).max(8),
});
export type ProposalOutput = z.infer<typeof ProposalOutput>;
