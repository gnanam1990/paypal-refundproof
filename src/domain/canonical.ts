import { createHash } from 'node:crypto';

export class CanonicalizationError extends Error {
  override readonly name = 'CanonicalizationError';
}

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no whitespace, and only values with one stable
 * encoding (null, booleans, strings, safe integers, arrays, plain objects). Anything else throws, because an
 * unstable digest input is a stop condition, not something to paper over.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

function encode(v: unknown, depth: number): string {
  if (depth > 32) throw new CanonicalizationError('nesting too deep');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isSafeInteger(v))
        throw new CanonicalizationError('only safe integers are canonical numbers');
      return Object.is(v, -0) ? '0' : String(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => encode(x, depth + 1)).join(',')}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalizationError('only plain objects');
      const entries = Object.keys(v as object).sort();
      return `{${entries
        .map((k) => {
          const x = (v as Record<string, unknown>)[k];
          if (x === undefined) throw new CanonicalizationError(`undefined value at ${k}`);
          return `${JSON.stringify(k)}:${encode(x, depth + 1)}`;
        })
        .join(',')}}`;
    }
    default:
      throw new CanonicalizationError(`non-canonical type ${typeof v}`);
  }
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Domain-separated digest: sha256(domain + "\n" + canonicalJson(value)). */
export function domainDigest(domain: string, value: unknown): string {
  if (!/^[a-z0-9/._-]+$/.test(domain)) throw new CanonicalizationError('invalid digest domain');
  return sha256Hex(`${domain}\n${canonicalJson(value)}`);
}

export const isHexDigest = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
