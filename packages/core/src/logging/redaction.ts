/** Field names whose values are always secret (CLAUDE.md §12). */
const SECRET_KEYS = [
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'authorization',
  'cookie',
  'joinToken',
  'privateKey',
  'secretAccessKey',
  'clientSecret',
];

/** pino redact paths: each secret key at the top level and one or two levels down. */
export const DEFAULT_REDACT_PATHS: readonly string[] = SECRET_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
]);

export const REDACTED = '[REDACTED]';

/** Recursively replaces bigint values with decimal strings so no precision is lost. */
export function stringifyBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stringifyBigInts);
  if (typeof value === 'object' && value !== null && !(value instanceof Error)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stringifyBigInts(v);
    return out;
  }
  return value;
}
