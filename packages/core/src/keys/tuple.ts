import type { MindlogError } from '../errors/mindlog-error.js';
import { mindlogError } from '../errors/mindlog-error.js';
import type { Result } from '../result/result.js';
import { err, ok } from '../result/result.js';
import { ByteWriter } from './byte-writer.js';
import { ESCAPE, TupleCode } from './tuple-codes.js';

/**
 * A value that can appear in an order-preserving key tuple. Integers are
 * `bigint` (CLAUDE.md rule 4) in the range ±(2^64 − 1).
 */
export type TupleElement = null | Uint8Array | string | bigint;

export type Tuple = readonly TupleElement[];

const utf8 = new TextEncoder();
const MAX_INT_MAGNITUDE = (1n << 64n) - 1n;

/**
 * Encodes a tuple so that byte-wise order equals tuple order (PLAN 5.1).
 * Elements are self-delimiting, so encodings of tuple prefixes are byte prefixes.
 */
export function encodeTuple(tuple: Tuple): Result<Uint8Array, MindlogError> {
  const writer = new ByteWriter();
  const written = appendTuple(writer, tuple);
  return written.ok ? ok(writer.finish()) : written;
}

/** Appends the encoding of each element to `writer`. */
export function appendTuple(writer: ByteWriter, tuple: Tuple): Result<void, MindlogError> {
  for (const element of tuple) {
    const written = appendElement(writer, element);
    if (!written.ok) return written;
  }
  return ok(undefined);
}

function appendElement(writer: ByteWriter, element: TupleElement): Result<void, MindlogError> {
  if (element === null) {
    writer.byte(TupleCode.NULL);
  } else if (typeof element === 'bigint') {
    return appendInt(writer, element);
  } else if (element instanceof Uint8Array) {
    writer.byte(TupleCode.BYTES);
    appendEscaped(writer, element);
  } else {
    if (!element.isWellFormed()) {
      return err(mindlogError('INVALID_ARGUMENT', 'key strings must be well-formed UTF-16'));
    }
    writer.byte(TupleCode.STRING);
    appendEscaped(writer, utf8.encode(element));
  }
  return ok(undefined);
}

/**
 * Variable-length integer: the type code is INT_ZERO ± byte length, so sign and
 * magnitude order fall out of the code; negatives store the one's complement.
 */
function appendInt(writer: ByteWriter, value: bigint): Result<void, MindlogError> {
  if (value === 0n) {
    writer.byte(TupleCode.INT_ZERO);
    return ok(undefined);
  }
  const magnitude = value < 0n ? -value : value;
  if (magnitude > MAX_INT_MAGNITUDE) {
    return err(
      mindlogError('KEY_ENCODING_OUT_OF_RANGE', `integer key element out of range: ${value}`),
    );
  }
  const length = byteLength(magnitude);
  const payload = value > 0n ? value : (1n << BigInt(8 * length)) - 1n + value;
  writer.byte(value > 0n ? TupleCode.INT_ZERO + length : TupleCode.INT_ZERO - length);
  for (let shift = 8 * (length - 1); shift >= 0; shift -= 8) {
    writer.byte(Number((payload >> BigInt(shift)) & 0xffn));
  }
  return ok(undefined);
}

function byteLength(magnitude: bigint): number {
  let length = 0;
  for (let m = magnitude; m > 0n; m >>= 8n) length++;
  return length;
}

/** Writes bytes with 0x00 escaped as 0x00 0xff, then a 0x00 terminator. */
function appendEscaped(writer: ByteWriter, data: Uint8Array): void {
  for (const byte of data) {
    writer.byte(byte);
    if (byte === 0x00) writer.byte(ESCAPE);
  }
  writer.byte(0x00);
}
