import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

/** Server-generated identifier: `<prefix>_` + 26 base32 chars (130 bits). 256 % 32 === 0, so byte % 32 is uniform. */
export function newId(prefix: string): string {
  return `${prefix}_${Array.from(randomBytes(26), (b) => ALPHABET[b % 32]).join('')}`;
}

export const correlationId = () => newId('cor');
