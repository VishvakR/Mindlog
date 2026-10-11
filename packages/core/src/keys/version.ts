import type { MindlogError } from '../errors/mindlog-error.js';
import { mindlogError } from '../errors/mindlog-error.js';
import type { Result } from '../result/result.js';
import { err, ok } from '../result/result.js';
import type { ByteWriter } from './byte-writer.js';
import { TupleCode } from './tuple-codes.js';

const MAX_VERSION = (1n << 64n) - 1n;

/** Encoded length of a version suffix: marker byte + 8-byte inverted index. */
export const VERSION_SUFFIX_LENGTH = 9;

/**
 * MVCC version suffix (PLAN 5.1): the '@' marker (0x40) followed by the
 * bitwise-NOT of the commit index as 8 big-endian bytes, so for one logical
 * key the newest version sorts first.
 */
export function appendVersion(writer: ByteWriter, index: bigint): Result<void, MindlogError> {
  if (index < 0n || index > MAX_VERSION) {
    return err(mindlogError('KEY_ENCODING_OUT_OF_RANGE', `version out of range: ${index}`));
  }
  const inverted = MAX_VERSION ^ index;
  writer.byte(TupleCode.VERSION);
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    writer.byte(Number((inverted >> shift) & 0xffn));
  }
  return ok(undefined);
}
