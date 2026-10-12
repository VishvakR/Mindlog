import { ByteWriter, TupleCode, VERSION_SUFFIX_LENGTH, appendVersion } from '@mindlog/core';

const MAX_VERSION = (1n << 64n) - 1n;

/** `logical · 0x40 · ~index` (PLAN 5.1): versions of a key sort newest first. */
export function versionedKey(logical: Uint8Array, index: bigint): Uint8Array {
  const writer = new ByteWriter(logical.length + VERSION_SUFFIX_LENGTH);
  writer.bytes(logical);
  const written = appendVersion(writer, index);
  if (!written.ok) throw new RangeError(written.error.message);
  return writer.finish();
}

export interface ParsedVersionedKey {
  readonly logical: Uint8Array;
  readonly index: bigint;
}

/** Splits a raw stored key into its logical key and commit index. */
export function parseVersionedKey(raw: Uint8Array): ParsedVersionedKey | undefined {
  const at = raw.length - VERSION_SUFFIX_LENGTH;
  if (at < 0 || raw[at] !== TupleCode.VERSION) return undefined;
  let inverted = 0n;
  for (let i = at + 1; i < raw.length; i++) inverted = (inverted << 8n) | BigInt(raw[i] ?? 0);
  return { logical: raw.subarray(0, at), index: MAX_VERSION ^ inverted };
}

/** First raw key after every version of `logical` and every key extending it. */
export function keyAfter(logical: Uint8Array): Uint8Array {
  const out = new Uint8Array(logical.length + 1);
  out.set(logical);
  out[logical.length] = TupleCode.VERSION + 1;
  return out;
}
