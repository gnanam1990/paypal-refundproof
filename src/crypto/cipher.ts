import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for customer evidence at rest. Layout: version(1) | iv(12) | tag(16) | ciphertext.
 * The key never leaves the server process; keyId is a non-reversible fingerprint for rotation bookkeeping.
 */
export class EvidenceCipher {
  private readonly macKey: Buffer;
  private readonly deviceKey: Buffer;
  private constructor(
    private readonly key: Buffer,
    readonly keyId: string,
  ) {
    // Separate HKDF-derived keys per purpose, so the encryption key is never used as a MAC key and a MAC for
    // one purpose can never be replayed as another.
    this.macKey = Buffer.from(hkdfSync('sha256', key, 'refundproof', 'refundproof/evidence-digest/v1', 32));
    this.deviceKey = Buffer.from(hkdfSync('sha256', key, 'refundproof', 'refundproof/device-cookie/v1', 32));
  }

  /** MAC binding a sign-in device cookie to one account (see src/auth/device.ts). */
  deviceMac(accountId: string, nonce: string): string {
    return createHmac('sha256', this.deviceKey)
      .update(`refundproof/device/v1\n${accountId}\n${nonce}`)
      .digest('hex');
  }

  /**
   * Keyed evidence digest: HMAC-SHA256 over kind and the exact original. Unlike an unkeyed hash it cannot be
   * used to confirm a guessed original (redaction would otherwise be defeated by guessing card numbers,
   * names, etc.). Rotating REFUNDPROOF_DATA_KEY therefore requires re-keying stored digests.
   */
  evidenceDigest(kind: string, original: string): string {
    return createHmac('sha256', this.macKey)
      .update(`refundproof/evidence/v2\n${kind}\n`)
      .update(original, 'utf8')
      .digest('hex');
  }

  static fromBase64Key(b64: string): EvidenceCipher {
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error('REFUNDPROOF_DATA_KEY must be 32 bytes, base64-encoded');
    return new EvidenceCipher(key, createHash('sha256').update(key).digest('hex').slice(0, 12));
  }

  encrypt(plain: Buffer, aad = 'refundproof/evidence/v1'): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, aad = 'refundproof/evidence/v1'): Buffer {
    if (blob[0] !== 1) throw new Error('unsupported ciphertext version');
    const d = createDecipheriv('aes-256-gcm', this.key, blob.subarray(1, 13));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([d.update(blob.subarray(29)), d.final()]);
  }
}
