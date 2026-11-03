import type { FieldSpec } from './field-spec.js';

export const numberField: FieldSpec<'number'> = {
  type: 'number',
  zero: () => 0,
  normalize(_f, v) {
    if (typeof v === 'number') return v;
    if (v === '' || v == null) return 0;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return typeof v === 'boolean' ? Number(v) : undefined;
  },
  validate(f, v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'must be a number';
    if (f.onlyInt && !Number.isInteger(v)) return 'must be an integer';
    if (f.min !== null && v < f.min) return `must be at least ${String(f.min)}`;
    if (f.max !== null && v > f.max) return `must be at most ${String(f.max)}`;
    return f.required && v === 0 ? 'cannot be blank' : undefined;
  },
};

export const boolField: FieldSpec<'bool'> = {
  type: 'bool',
  zero: () => false,
  normalize(_f, v) {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === '1' || v === 1 || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 0 || v === '' || v == null) return false;
    return undefined;
  },
  validate: (f, v) =>
    typeof v !== 'boolean'
      ? 'must be true or false'
      : f.required && !v
        ? 'must be true'
        : undefined,
};

function jsonSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v === undefined ? null : v));
}

export const jsonField: FieldSpec<'json'> = {
  type: 'json',
  zero: () => null,
  normalize(_f, v) {
    if (typeof v !== 'string') return v === undefined ? null : v;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  },
  validate(f, v) {
    if (f.maxSize > 0 && jsonSize(v) > f.maxSize) return `at most ${String(f.maxSize)} bytes`;
    const empty = v === null || v === '' || (Array.isArray(v) && v.length === 0);
    return f.required && empty ? 'cannot be blank' : undefined;
  },
};

const isPoint = (v: unknown): v is { lon: number; lat: number } =>
  v !== null &&
  typeof v === 'object' &&
  Object.keys(v).length === 2 &&
  typeof (v as Record<string, unknown>)['lon'] === 'number' &&
  typeof (v as Record<string, unknown>)['lat'] === 'number';

export const geoPointField: FieldSpec<'geoPoint'> = {
  type: 'geoPoint',
  zero: () => ({ lon: 0, lat: 0 }),
  normalize(_f, v) {
    const raw = typeof v === 'string' ? safeJson(v) : v;
    if (raw == null || raw === '') return { lon: 0, lat: 0 };
    if (typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    return { lon: Number(r['lon']), lat: Number(r['lat']) };
  },
  validate(f, v) {
    if (!isPoint(v)) return 'must be {lon, lat}';
    if (!(Math.abs(v.lon) <= 180 && Math.abs(v.lat) <= 90))
      return 'lon must be within ±180 and lat within ±90';
    return f.required && v.lon === 0 && v.lat === 0 ? 'cannot be blank' : undefined;
  },
};

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Embeddings of a source text field, computed on the leader (ADR-0016); `null` until embedded. */
export const vectorField: FieldSpec<'vector'> = {
  type: 'vector',
  zero: () => null,
  normalize: (_f, v) => (v === undefined || v === '' ? null : v),
  validate(f, v) {
    if (v === null) return f.required ? 'cannot be blank' : undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
      return 'must be a list of numbers';
    return f.dimensions > 0 && v.length !== f.dimensions
      ? `must have ${String(f.dimensions)} dimensions`
      : undefined;
  },
};
