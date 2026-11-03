import { baseOp } from './ast.js';
import type { CompareOp } from './ast.js';

type Scalar = string | number | boolean | null;

/** Values a comparison sees: arrays and objects compare by their JSON text. */
function scalar(value: unknown): Scalar {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  return JSON.stringify(value);
}

const isEmpty = (v: Scalar): boolean => v === null || v === '';

function asNumber(v: Scalar): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** Numeric when either side is a number or bool and both read as numbers; text otherwise. */
function order(a: Scalar, b: Scalar): number {
  if (
    typeof a === 'number' ||
    typeof b === 'number' ||
    typeof a === 'boolean' ||
    typeof b === 'boolean'
  ) {
    const x = asNumber(a);
    const y = asNumber(b);
    if (x !== undefined && y !== undefined) return x === y ? 0 : x < y ? -1 : 1;
  }
  const s = String(a ?? '');
  const t = String(b ?? '');
  return s === t ? 0 : s < t ? -1 : 1;
}

function equal(a: Scalar, b: Scalar): boolean {
  // PocketBase's null fallback: null and '' are the same value.
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  return order(a, b) === 0;
}

function like(value: Scalar, pattern: Scalar): boolean {
  const text = String(value ?? '').toLowerCase();
  const p = String(pattern ?? '').toLowerCase();
  if (!p.includes('%')) return text.includes(p);
  const re = p
    .split('%')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`, 's').test(text);
}

/** One comparison of two single values with PocketBase semantics (ADR-0018). */
export function compareValues(op: CompareOp, left: unknown, right: unknown): boolean {
  const a = scalar(left);
  const b = scalar(right);
  switch (baseOp(op)) {
    case '=':
      return equal(a, b);
    case '!=':
      return !equal(a, b);
    case '~':
      return like(a, b);
    case '!~':
      return !like(a, b);
    default: {
      if (a === null || b === null) return false;
      const c = order(a, b);
      switch (baseOp(op)) {
        case '>':
          return c > 0;
        case '>=':
          return c >= 0;
        case '<':
          return c < 0;
        default:
          return c <= 0;
      }
    }
  }
}
