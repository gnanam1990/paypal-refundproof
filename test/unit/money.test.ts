import { describe, expect, it } from 'vitest';
import { MAX_MINOR, MoneyError, compareMoney, formatMoney, money, parseMoney } from '../../src/domain/money';

describe('Money', () => {
  it('parses and formats exact PayPal decimal strings without rounding', () => {
    expect(parseMoney('10.00', 'USD')).toEqual({ currency: 'USD', minor: 1000n });
    expect(parseMoney('10.5', 'USD')).toEqual({ currency: 'USD', minor: 1050n });
    expect(formatMoney(money('USD', 1050n))).toBe('10.50');
    expect(formatMoney(money('JPY', 1200n))).toBe('1200');
    expect(formatMoney(money('USD', 7n))).toBe('0.07');
  });

  it('rejects fractional digits beyond the currency exponent instead of rounding', () => {
    expect(() => parseMoney('10.001', 'USD')).toThrow(MoneyError);
    expect(() => parseMoney('10.5', 'JPY')).toThrow(MoneyError);
    expect(() => parseMoney('1.0', 'HUF')).toThrow(MoneyError);
  });

  it.each(['', ' 1.00', '1.00 ', '-1.00', '+1', '1e3', '01.00', '.5', '1.', 'NaN', '0x10', '1,00'])(
    'rejects malformed value %j',
    (value) => {
      expect(() => parseMoney(value, 'USD')).toThrow(MoneyError);
    },
  );

  it('rejects unsupported or lowercase currency codes', () => {
    expect(() => parseMoney('1.00', 'usd')).toThrow(MoneyError);
    expect(() => parseMoney('1.00', 'XXX')).toThrow(MoneyError);
    expect(() => money('BTC' as never, 1n)).toThrow(MoneyError);
  });

  it('rejects overflow beyond the supported maximum', () => {
    expect(() => money('USD', MAX_MINOR + 1n)).toThrow(MoneyError);
    expect(() => parseMoney('99999999999999999999.00', 'USD')).toThrow(MoneyError);
    expect(formatMoney(money('USD', MAX_MINOR))).toBe('9999999999.99');
  });

  it('rejects negative minor units', () => {
    expect(() => money('USD', -1n)).toThrow(MoneyError);
  });

  it('refuses to compare different currencies', () => {
    expect(compareMoney(money('USD', 1n), money('USD', 2n))).toBe(-1);
    expect(() => compareMoney(money('USD', 1n), money('EUR', 1n))).toThrow(MoneyError);
  });
});
