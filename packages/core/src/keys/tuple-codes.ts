/**
 * Tuple element type codes, from the FoundationDB tuple layer (PLAN 5.1).
 * Code order is part of the on-disk sort order: never renumber.
 */
export const TupleCode = {
  NULL: 0x00,
  BYTES: 0x01,
  STRING: 0x02,
  /** Integers use 0x0c..0x1c: INT_ZERO ± byte length. */
  INT_ZERO: 0x14,
  DOUBLE: 0x21,
  FALSE: 0x26,
  TRUE: 0x27,
  /** MVCC version marker ('@'), from the FDB user range; above every element code. */
  VERSION: 0x40,
} as const;

/** Escape byte that follows an embedded 0x00 inside bytes and strings. */
export const ESCAPE = 0xff;
