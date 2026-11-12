import { describe, expect, it } from 'vitest';
import { CanonicalizationError, canonicalJson, domainDigest } from '../../src/domain/canonical';

describe('canonical JSON', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 'x'], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, 'x'] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: true })).toBe('{"a":true,"b":1}');
  });

  it.each([
    ['float', 1.5],
    ['NaN', Number.NaN],
    ['unsafe integer', 2 ** 60],
    ['undefined', undefined],
    ['bigint', 1n],
    ['function', () => 1],
    ['date', new Date(0)],
    ['nested undefined', { a: undefined }],
  ])('rejects unstable value: %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalizationError);
  });

  it('separates digest domains', () => {
    expect(domainDigest('a', { x: 1 })).not.toBe(domainDigest('b', { x: 1 }));
  });

  it('matches a golden vector computed independently with shasum', () => {
    expect(canonicalJson({ currency: 'USD', amount: '10.00' })).toBe('{"amount":"10.00","currency":"USD"}');
    expect(domainDigest('refundproof/test/v1', { currency: 'USD', amount: '10.00' })).toBe(
      'd7c1de9222b708c0a383dbb098548e76137f11bb86093389ff2afc948810f81a',
    );
  });
});
