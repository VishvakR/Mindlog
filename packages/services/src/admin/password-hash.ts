import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt cost (ADR-0024): ~50 ms on a laptop core; parameters are stored with the hash.
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, key) => {
      if (e) reject(e);
      else resolve(key);
    });
  });

/** `scrypt$N$r$p$<salt b64>$<key b64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time check; false for any malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(
    password,
    Buffer.from(salt, 'base64'),
    Number(n),
    Number(r),
    Number(p),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash for an unknown user, so failed logins take as long as real ones. */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEY_LENGTH).toString('base64')}`;
