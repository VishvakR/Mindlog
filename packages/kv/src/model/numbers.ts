const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const FLOAT = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

export { INT64_MAX, INT64_MIN };

/**
 * Parses a Redis integer argument strictly (Valkey string2ll): optional minus,
 * no plus sign, no spaces, no leading zeros, within int64.
 */
export function parseInteger(bytes: Uint8Array): bigint | undefined {
  if (bytes.length === 0 || bytes.length > 20) return undefined;
  const text = decoder.decode(bytes);
  if (!INTEGER.test(text) || text === '-0') return undefined;
  const value = BigInt(text);
  return value < INT64_MIN || value > INT64_MAX ? undefined : value;
}

/** Parses a Redis float argument: decimal or exponent forms and ±inf; no NaN. */
export function parseFloat64(bytes: Uint8Array): number | undefined {
  const text = decoder.decode(bytes);
  const lower = text.toLowerCase();
  if (lower === 'inf' || lower === '+inf' || lower === 'infinity' || lower === '+infinity') {
    return Number.POSITIVE_INFINITY;
  }
  if (lower === '-inf' || lower === '-infinity') return Number.NEGATIVE_INFINITY;
  if (!FLOAT.test(text)) return undefined;
  const value = Number(text);
  return Number.isNaN(value) ? undefined : value;
}

/** Shortest round-trip text for a double, as Redis replies print it. */
export function formatDouble(value: number): string {
  if (value === Number.POSITIVE_INFINITY) return 'inf';
  if (value === Number.NEGATIVE_INFINITY) return '-inf';
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

export const formatInteger = (value: bigint): Uint8Array => encoder.encode(value.toString());
export const textBytes = (text: string): Uint8Array => encoder.encode(text);
