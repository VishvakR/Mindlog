/** Stored value envelope: a live value or a tombstone marking a delete. */
const LIVE = 0x01;
const TOMBSTONE = 0x00;

export function encodeLive(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(value.length + 1);
  out[0] = LIVE;
  out.set(value, 1);
  return out;
}

export const TOMBSTONE_VALUE: Uint8Array = Uint8Array.of(TOMBSTONE);

/** The value, or `undefined` for a tombstone. Throws on a corrupt envelope (fail-stop). */
export function decodeVersionValue(stored: Uint8Array): Uint8Array | undefined {
  if (stored[0] === LIVE) return stored.subarray(1);
  if (stored[0] === TOMBSTONE && stored.length === 1) return undefined;
  throw new Error('corrupt MVCC value envelope');
}
