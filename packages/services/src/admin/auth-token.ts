import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenClaims {
  /** Superuser email. */
  readonly sub: string;
  /** Expiry, Unix milliseconds. */
  readonly exp: number;
}

const sign = (payload: string, key: string) =>
  createHmac('sha256', key).update(payload).digest('base64url');

/** `base64url(claims).base64url(HMAC-SHA256(key, claims))` (ADR-0024). */
export function signToken(claims: TokenClaims, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

/** The unverified claims, to look up the signing key; undefined when malformed. */
export function readClaims(token: string): TokenClaims | undefined {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      typeof claims === 'object' &&
      claims !== null &&
      'sub' in claims &&
      'exp' in claims &&
      typeof claims.sub === 'string' &&
      typeof claims.exp === 'number'
    ) {
      return { sub: claims.sub, exp: claims.exp };
    }
  } catch {
    // fall through: not JSON
  }
  return undefined;
}

/** Constant-time signature check. */
export function hasValidSignature(token: string, key: string): boolean {
  const [payload = '', signature = ''] = token.split('.');
  const expected = Buffer.from(sign(payload, key));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
