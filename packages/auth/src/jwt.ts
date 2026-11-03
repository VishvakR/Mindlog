import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a token is for; a token of one type is never accepted as another. */
export type TokenType = 'access' | 'delegated' | 'file' | 'verify' | 'reset' | 'oauth2';

export interface TokenClaims {
  /** Record id, or '' for tokens about no record (OAuth2 state). */
  readonly sub: string;
  /** Auth collection of the record. */
  readonly col: string;
  /** Tenant the token is valid in. */
  readonly ten: string;
  readonly typ: TokenType;
  /** Issued and expiry times, Unix seconds (RFC 7519). */
  readonly iat: number;
  readonly exp: number;
  /** Delegated tokens: the API key id of the acting agent (ADR-0035). */
  readonly act?: string;
  /** Free-form extra data, e.g. an email or an OAuth2 verifier. */
  readonly dat?: Readonly<Record<string, string>>;
}

const b64 = (s: string): string => Buffer.from(s).toString('base64url');
const HEADER_FIELDS = ['alg', 'typ', 'kid'];

/** An HS256 JWT signed with `key` (the key set's secret joined with the record's `tokenKey`). */
export function signJwt(claims: TokenClaims, kid: string, key: string): string {
  const head = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid }))}.${b64(JSON.stringify(claims))}`;
  return `${head}.${createHmac('sha256', key).update(head).digest('base64url')}`;
}

export interface UnverifiedJwt {
  readonly kid: string;
  readonly claims: TokenClaims;
}

function isClaims(v: unknown): v is TokenClaims {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c['sub'] === 'string' &&
    typeof c['col'] === 'string' &&
    typeof c['ten'] === 'string' &&
    typeof c['typ'] === 'string' &&
    typeof c['iat'] === 'number' &&
    typeof c['exp'] === 'number' &&
    (c['act'] === undefined || typeof c['act'] === 'string')
  );
}

/** The header's key id and the claims, before the signature is checked (to look up the key). */
export function readJwt(token: string): UnverifiedJwt | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const header: unknown = JSON.parse(Buffer.from(parts[0] ?? '', 'base64url').toString('utf8'));
    const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    if (typeof header !== 'object' || header === null) return undefined;
    const h = header as Record<string, unknown>;
    if (
      h['alg'] !== 'HS256' ||
      typeof h['kid'] !== 'string' ||
      !Object.keys(h).every((k) => HEADER_FIELDS.includes(k))
    ) {
      return undefined;
    }
    return isClaims(claims) ? { kid: h['kid'], claims } : undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time signature check plus expiry; `nowS` in Unix seconds. */
export function verifyJwt(token: string, key: string, nowS: number): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const expected = Buffer.from(
    createHmac('sha256', key)
      .update(`${parts[0] ?? ''}.${parts[1] ?? ''}`)
      .digest('base64url'),
  );
  const actual = Buffer.from(parts[2] ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  const read = readJwt(token);
  return read !== undefined && read.claims.exp > nowS;
}
