import { parseFloat64 } from '../../model/numbers.js';

export interface ScoreBound {
  readonly value: number;
  readonly exclusive: boolean;
}

/** `1.5`, `(1.5` (exclusive), `-inf`, `+inf`. */
export function parseScoreBound(raw: Uint8Array): ScoreBound | undefined {
  const exclusive = raw[0] === 0x28; // '('
  const value = parseFloat64(exclusive ? raw.subarray(1) : raw);
  return value === undefined ? undefined : { value, exclusive };
}

export type LexBound =
  | { readonly kind: 'min' }
  | { readonly kind: 'max' }
  | { readonly kind: 'value'; readonly value: Uint8Array; readonly exclusive: boolean };

/** `-` (minimum), `+` (maximum), `[x` (inclusive), `(x` (exclusive). */
export function parseLexBound(raw: Uint8Array): LexBound | undefined {
  if (raw.length === 1 && raw[0] === 0x2d) return { kind: 'min' };
  if (raw.length === 1 && raw[0] === 0x2b) return { kind: 'max' };
  if (raw[0] === 0x5b) return { kind: 'value', value: raw.subarray(1), exclusive: false };
  if (raw[0] === 0x28) return { kind: 'value', value: raw.subarray(1), exclusive: true };
  return undefined;
}

/** Normalises -0 to 0 so equal scores share one position in the score index. */
export const normaliseScore = (score: number): number => (score === 0 ? 0 : score);
