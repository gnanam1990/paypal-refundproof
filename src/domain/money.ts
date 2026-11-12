/**
 * Exact money for PayPal amounts. Values are integer minor units; there is no floating point and no rounding.
 * Exponents follow PayPal's currency-code table (HUF, JPY and TWD do not support decimals).
 */
export const CURRENCY_EXPONENTS = Object.freeze({
  AUD: 2,
  BRL: 2,
  CAD: 2,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  HKD: 2,
  HUF: 0,
  ILS: 2,
  JPY: 0,
  MYR: 2,
  MXN: 2,
  TWD: 0,
  NZD: 2,
  NOK: 2,
  PHP: 2,
  PLN: 2,
  GBP: 2,
  SGD: 2,
  SEK: 2,
  CHF: 2,
  THB: 2,
  USD: 2,
} as const);

export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

export interface Money {
  readonly currency: CurrencyCode;
  readonly minor: bigint;
}

/** Largest accepted amount in minor units (fits PostgreSQL bigint and PayPal's 32-char value with margin). */
export const MAX_MINOR = 999_999_999_999n;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, value);
}

export function exponentOf(currency: CurrencyCode): number {
  return CURRENCY_EXPONENTS[currency];
}

export function money(currency: CurrencyCode, minor: bigint): Money {
  if (!isCurrencyCode(currency)) throw new MoneyError(`unsupported currency ${String(currency)}`);
  if (typeof minor !== 'bigint') throw new MoneyError('minor units must be a bigint');
  if (minor < 0n) throw new MoneyError('negative amounts are not money in this domain');
  if (minor > MAX_MINOR) throw new MoneyError('amount exceeds supported maximum');
  return Object.freeze({ currency, minor });
}

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Strictly parse a PayPal `value` string. More fractional digits than the currency allows is an error. */
export function parseMoney(value: string, currency: string): Money {
  if (!isCurrencyCode(currency)) throw new MoneyError(`unsupported currency ${currency}`);
  if (typeof value !== 'string' || value.length > 32) throw new MoneyError('malformed amount');
  const m = DECIMAL.exec(value);
  if (!m) throw new MoneyError('malformed amount');
  const exp = exponentOf(currency);
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (m[2] !== undefined && frac.length === 0) throw new MoneyError('malformed amount');
  if (frac.length > exp) throw new MoneyError(`${currency} supports at most ${exp} fractional digits`);
  if (whole.length > 15) throw new MoneyError('amount exceeds supported maximum');
  const minor = BigInt(whole) * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, '0') || '0');
  return money(currency, minor);
}

/** Format exactly as PayPal expects: the currency's exact number of fractional digits. */
export function formatMoney(m: Money): string {
  const exp = exponentOf(m.currency);
  if (exp === 0) return m.minor.toString();
  const s = m.minor.toString().padStart(exp + 1, '0');
  return `${s.slice(0, -exp)}.${s.slice(-exp)}`;
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  if (a.currency !== b.currency) throw new MoneyError('cannot compare different currencies');
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export interface MoneyJson {
  currency: CurrencyCode;
  value: string;
}

export const moneyToJson = (m: Money): MoneyJson => ({ currency: m.currency, value: formatMoney(m) });
export const moneyFromJson = (j: { currency: string; value: string }): Money =>
  parseMoney(j.value, j.currency);
