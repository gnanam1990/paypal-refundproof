import { z } from 'zod';
import { BOUND_ID_SOURCE } from './bound-id';
import { CURRENCY_EXPONENTS, MAX_MINOR, MoneyError, parseMoney, type CurrencyCode } from './money';
import { MAX_EVIDENCE_DIGESTS, REFUND_REASON_CODES } from './proposal';

/**
 * The exported JSON Schema must enforce exactly what the domain enforces (H1), so the value pattern is derived
 * per currency exponent and encodes: no leading zeros, at most `exponent` fractional digits, strictly positive,
 * and at most MAX_MINOR minor units. The patterns assume MAX_MINOR = 10^12 - 1; fail loudly if that changes.
 */
const MAX_MINOR_DIGITS = 12;
if (MAX_MINOR !== 10n ** BigInt(MAX_MINOR_DIGITS) - 1n) {
  throw new Error('schemas.ts value patterns assume MAX_MINOR = 10^12 - 1');
}

export function positiveValuePattern(exponent: number): string {
  const wholeMax = MAX_MINOR_DIGITS - exponent; // digits allowed before the decimal point
  if (exponent === 0) return `^[1-9][0-9]{0,${wholeMax - 1}}$`;
  // 0.x positives without lookaround (portable to RE2 validators): the first non-zero digit sits at
  // fractional position k (1..exponent), preceded by k-1 zeros and followed by up to exponent-k digits.
  const fractional = Array.from(
    { length: exponent },
    (_, i) => `${'0'.repeat(i)}[1-9][0-9]{0,${exponent - i - 1}}`,
  ).join('|');
  return `^(?:[1-9][0-9]{0,${wholeMax - 1}}(?:\\.[0-9]{1,${exponent}})?|0\\.(?:${fractional}))$`;
}

const byExponent = new Map<number, CurrencyCode[]>();
for (const [c, e] of Object.entries(CURRENCY_EXPONENTS) as [CurrencyCode, number][]) {
  byExponent.set(e, [...(byExponent.get(e) ?? []), c]);
}

const moneyVariants = [...byExponent.entries()]
  .sort(([a], [b]) => b - a)
  .map(([exp, codes]) =>
    z.strictObject({
      currency: z.enum(codes as [CurrencyCode, ...CurrencyCode[]]),
      value: z.string().regex(new RegExp(positiveValuePattern(exp))),
    }),
  );

/** PayPal money object: exact for its currency, strictly positive, within MAX_MINOR. */
export const PositiveMoneyJson = z
  .union(moneyVariants as unknown as [(typeof moneyVariants)[0], ...typeof moneyVariants])
  .superRefine((m, ctx) => {
    // Belt and braces: the domain parser must agree with the pattern at runtime.
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

const id = z.string().regex(new RegExp(BOUND_ID_SOURCE), 'printable ASCII identifier, 1..128, no whitespace');

export const RevisionContentJson = z.strictObject({
  tenantId: id,
  caseId: id,
  captureId: id,
  amount: AmountSemanticJson,
  reason: z.strictObject({
    code: z.enum(REFUND_REASON_CODES),
    noteToPayer: z.string().min(1).max(255).nullable(),
  }),
  evidenceDigests: z
    .array(z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex'))
    .min(1)
    .max(MAX_EVIDENCE_DIGESTS),
  policyVersion: id,
});

export const revisionContentJsonSchema = () => z.toJSONSchema(RevisionContentJson, { io: 'input' });
