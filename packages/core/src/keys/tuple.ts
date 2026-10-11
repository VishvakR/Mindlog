import type { MindlogError } from '../errors/mindlog-error.js';
import { mindlogError } from '../errors/mindlog-error.js';
import type { Result } from '../result/result.js';
import { err, ok } from '../result/result.js';
import { ByteWriter } from './byte-writer.js';
import { ESCAPE, TupleCode } from './tuple-codes.js';

/** A value that can appear in an order-preserving key tuple. */
export type TupleElement = null | Uint8Array | string;

export type Tuple = readonly TupleElement[];

const utf8 = new TextEncoder();

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

/** Writes bytes with 0x00 escaped as 0x00 0xff, then a 0x00 terminator. */
function appendEscaped(writer: ByteWriter, data: Uint8Array): void {
  for (const byte of data) {
    writer.byte(byte);
    if (byte === 0x00) writer.byte(ESCAPE);
  }
  writer.byte(0x00);
}
