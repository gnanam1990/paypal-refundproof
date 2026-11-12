import { z } from 'zod';
import { isHexDigest } from './canonical';
import { CURRENCY_EXPONENTS, MoneyError, parseMoney } from './money';
import { REFUND_REASON_CODES } from './proposal';

const currency = z.enum(
  Object.keys(CURRENCY_EXPONENTS) as [
    keyof typeof CURRENCY_EXPONENTS,
    ...(keyof typeof CURRENCY_EXPONENTS)[],
  ],
);

/** PayPal money object; must parse exactly for its currency and be strictly positive. */
export const PositiveMoneyJson = z
  .strictObject({
    currency,
    value: z
      .string()
      .min(1)
      .max(32)
      .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
  })
  .superRefine((m, ctx) => {
    try {
      if (parseMoney(m.value, m.currency).minor <= 0n)
        ctx.addIssue({ code: 'custom', message: 'must be positive' });
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof MoneyError ? e.message : 'invalid money' });
    }
  });

export const AmountSemanticJson = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('EXACT'), amount: PositiveMoneyJson }),
  z.strictObject({ kind: z.literal('FULL'), captureAmount: PositiveMoneyJson }),
]);

const id = z.string().min(1).max(128);

export const RevisionContentJson = z.strictObject({
  tenantId: id,
  caseId: id,
  captureId: id,
  amount: AmountSemanticJson,
  reason: z.strictObject({
    code: z.enum(REFUND_REASON_CODES),
    noteToPayer: z.string().min(1).max(255).nullable(),
  }),
  evidenceDigests: z.array(z.string().refine(isHexDigest, 'sha256 hex')).min(1).max(64),
  policyVersion: id,
});

export const revisionContentJsonSchema = () => z.toJSONSchema(RevisionContentJson, { io: 'input' });
