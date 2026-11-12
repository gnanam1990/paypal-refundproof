import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { EvidenceCipher } from '../crypto/cipher';

/**
 * Device cookies (OWASP "slow down online guessing attacks with device cookies").
 *
 * A client that has signed in successfully receives `rp_device = v1.<accountId>.<nonce>.<mac>`, where the
 * MAC is keyed by an HKDF subkey of the server data key and binds the cookie to that one account. Failed
 * sign-ins that present a valid device cookie for the account being signed into are counted in that
 * device's own bucket; every other attempt shares the account's untrusted bucket. A remote attacker can
 * therefore exhaust only the untrusted bucket, not the owner's known devices, and cannot forge a device
 * cookie. It is not a credential: it never authenticates a request, and it carries no email or secret.
 */
export const DEVICE_COOKIE = 'rp_device';
export const DEVICE_COOKIE_MAX_AGE_SEC = 180 * 24 * 3600;
const PART = /^[A-Za-z0-9_-]{1,80}$/;
const MAC = /^[0-9a-f]{64}$/;

export interface Device {
  accountId: string;
  nonce: string;
  value: string;
}

export function mintDevice(cipher: EvidenceCipher, accountId: string): Device {
  const nonce = randomBytes(16).toString('base64url');
  return { accountId, nonce, value: `v1.${accountId}.${nonce}.${cipher.deviceMac(accountId, nonce)}` };
}

/** Returns the device only when the cookie is well-formed, authentic, and bound to `accountId`. */
export function verifyDevice(
  cipher: EvidenceCipher,
  value: string | undefined,
  accountId: string | undefined,
): Device | null {
  if (!value || !accountId) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [version, id, nonce, mac] = parts as [string, string, string, string];
  if (version !== 'v1' || !PART.test(id) || !PART.test(nonce) || !MAC.test(mac)) return null;
  const expected = Buffer.from(cipher.deviceMac(id, nonce), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) return null;
  if (id !== accountId) return null;
  return { accountId: id, nonce, value };
}
