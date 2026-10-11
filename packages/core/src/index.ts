/**
 * @mindlog/core — shared foundations for every Mindlog package (PLAN 4.2).
 * Exports only the public API; each module is added as it lands.
 */
export type { Err, Ok, Result } from './result/result.js';
export { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from './result/result.js';

export type { ErrorCodeSpec, McpErrorKind } from './errors/error-codes.js';
export { ERROR_CODES, GrpcStatus, MindlogErrorCode, problemType } from './errors/error-codes.js';
export type { ErrorDetailView, MindlogError, MindlogErrorOptions } from './errors/mindlog-error.js';
export { errorSpec, isRetryable, mindlogError, toErrorDetail } from './errors/mindlog-error.js';

export type { Clock } from './clock/clock.js';
export { ManualClock } from './clock/manual-clock.js';
export { SystemClock } from './clock/system-clock.js';

export type { Random } from './random/random.js';
export { SeededRandom } from './random/seeded-random.js';
export { SystemRandom } from './random/system-random.js';

export { UlidGenerator, isUlid, ulidTime } from './ids/ulid.js';

export type { Hlc, HlcOptions } from './hlc/hlc.js';
export { HybridLogicalClock, hlcLogical, hlcPhysical, packHlc } from './hlc/hlc.js';

export { ByteWriter } from './keys/byte-writer.js';
export { TupleCode } from './keys/tuple-codes.js';
export type { Tuple, TupleElement } from './keys/tuple.js';
export { appendTuple, encodeTuple } from './keys/tuple.js';
export { VERSION_SUFFIX_LENGTH, appendVersion } from './keys/version.js';
export type { DecodedTuple } from './keys/decode-tuple.js';
export { decodeTuple } from './keys/decode-tuple.js';
export type { KeyParts, KeyRange } from './keys/key.js';
export {
  KeyFamily,
  decodeKey,
  encodeKey,
  keyPrefix,
  prefixRange,
  versionsRange,
} from './keys/key.js';
