import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(
  password: string,
  salt: Buffer,
  len: number,
  o: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, len, { ...o, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new Error('password must be 12..256 characters');
  const salt = randomBytes(16);
  const h = await scrypt(password, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}

// Hash of a random password, so unknown accounts cost the same time as known ones.
let dummy: Promise<string> | undefined;

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  dummy ??= hashPassword(randomBytes(24).toString('base64'));
  const encoded = stored ?? (await dummy);
  const [alg, n, r, p, salt, hash] = encoded.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(password.slice(0, 256), Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return stored !== null && timingSafeEqual(got, expected);
}
