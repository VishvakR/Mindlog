import type { MindlogError } from '../errors/mindlog-error.js';
import { mindlogError } from '../errors/mindlog-error.js';
import type { Result } from '../result/result.js';
import { err, ok } from '../result/result.js';
import type { TupleElement } from './tuple.js';
import { ESCAPE, TupleCode } from './tuple-codes.js';

export interface DecodedTuple {
  readonly elements: TupleElement[];
  /** Commit index from a trailing version suffix, if present. */
  readonly version?: bigint;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_UINT64 = (1n << 64n) - 1n;
const MIN_INT_CODE = TupleCode.INT_ZERO - 8;
const MAX_INT_CODE = TupleCode.INT_ZERO + 8;

type Step = Result<{ value: TupleElement; next: number }, MindlogError>;

function fail(message: string, at: number): Result<never, MindlogError> {
  return err(mindlogError('KEY_DECODE_FAILED', `${message} at byte ${at}`));
}

/**
 * Decodes bytes produced by encodeTuple (plus an optional version suffix).
 * Strict: truncated, unknown or non-canonical input is an error, never a guess,
 * so every key has exactly one encoding.
 */
export function decodeTuple(bytes: Uint8Array): Result<DecodedTuple, MindlogError> {
  const elements: TupleElement[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const code = bytes[pos] ?? -1;
    if (code === TupleCode.VERSION) {
      const version = decodeVersion(bytes, pos);
      return version.ok ? ok({ elements, version: version.value }) : version;
    }
    const step = decodeElement(bytes, pos, code);
    if (!step.ok) return step;
    elements.push(step.value.value);
    pos = step.value.next;
  }
  return ok({ elements });
}

function decodeElement(bytes: Uint8Array, pos: number, code: number): Step {
  if (code === TupleCode.NULL) return ok({ value: null, next: pos + 1 });
  if (code === TupleCode.FALSE) return ok({ value: false, next: pos + 1 });
  if (code === TupleCode.TRUE) return ok({ value: true, next: pos + 1 });
  if (code === TupleCode.BYTES || code === TupleCode.STRING) return decodeEscaped(bytes, pos, code);
  if (code >= MIN_INT_CODE && code <= MAX_INT_CODE) return decodeInt(bytes, pos, code);
  if (code === TupleCode.DOUBLE) return decodeDouble(bytes, pos);
  return fail(`unknown type code 0x${code.toString(16).padStart(2, '0')}`, pos);
}

function decodeEscaped(bytes: Uint8Array, pos: number, code: number): Step {
  const out: number[] = [];
  let i = pos + 1;
  for (;;) {
    if (i >= bytes.length) return fail('unterminated bytes/string element', pos);
    const byte = bytes[i] ?? 0;
    if (byte !== 0x00) {
      out.push(byte);
      i++;
    } else if (bytes[i + 1] === ESCAPE) {
      out.push(0x00);
      i += 2;
    } else {
      break;
    }
  }
  const raw = Uint8Array.from(out);
  if (code === TupleCode.BYTES) return ok({ value: raw, next: i + 1 });
  try {
    return ok({ value: utf8.decode(raw), next: i + 1 });
  } catch {
    return fail('invalid UTF-8 in string element', pos);
  }
}

function decodeInt(bytes: Uint8Array, pos: number, code: number): Step {
  const length = Math.abs(code - TupleCode.INT_ZERO);
  if (pos + 1 + length > bytes.length) return fail('truncated integer element', pos);
  let payload = 0n;
  for (let i = 0; i < length; i++) payload = (payload << 8n) | BigInt(bytes[pos + 1 + i] ?? 0);
  const first = bytes[pos + 1];
  if (code > TupleCode.INT_ZERO) {
    if (first === 0x00) return fail('non-canonical integer element', pos);
    return ok({ value: payload, next: pos + 1 + length });
  }
  if (code < TupleCode.INT_ZERO && first === 0xff) {
    return fail('non-canonical integer element', pos);
  }
  const value = code === TupleCode.INT_ZERO ? 0n : payload - ((1n << BigInt(8 * length)) - 1n);
  return ok({ value, next: pos + 1 + length });
}

function decodeDouble(bytes: Uint8Array, pos: number): Step {
  if (pos + 9 > bytes.length) return fail('truncated double element', pos);
  const view = new DataView(new ArrayBuffer(8));
  const wasPositive = ((bytes[pos + 1] ?? 0) & 0x80) !== 0;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[pos + 1 + i] ?? 0;
    view.setUint8(i, wasPositive ? (i === 0 ? byte ^ 0x80 : byte) : byte ^ 0xff);
  }
  return ok({ value: view.getFloat64(0), next: pos + 9 });
}

function decodeVersion(bytes: Uint8Array, pos: number): Result<bigint, MindlogError> {
  if (bytes.length - pos !== 9) return fail('version suffix must be the last 9 bytes', pos);
  let inverted = 0n;
  for (let i = 1; i <= 8; i++) inverted = (inverted << 8n) | BigInt(bytes[pos + i] ?? 0);
  return ok(MAX_UINT64 ^ inverted);
}
