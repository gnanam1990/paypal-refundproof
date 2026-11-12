import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for customer evidence at rest. Layout: version(1) | iv(12) | tag(16) | ciphertext.
 * The key never leaves the server process; keyId is a non-reversible fingerprint for rotation bookkeeping.
 */
export class EvidenceCipher {
  private constructor(
    private readonly key: Buffer,
    readonly keyId: string,
  ) {}

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
