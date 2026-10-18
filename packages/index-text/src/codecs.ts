import type { Bm25Stats, Posting } from './bm25.js';

// Fixed-width little-endian values for postings, counts and stats (ADR-0031 keys hold them).

export function encodePosting(p: Posting): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, p.tf, true);
  view.setUint32(4, p.length, true);
  return out;
}

export function decodePosting(bytes: Uint8Array): Posting {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { tf: view.getUint32(0, true), length: view.getUint32(4, true) };
}

export function encodeCount(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

/** A missing count is zero. */
export function decodeCount(bytes: Uint8Array | undefined): number {
  if (!bytes) return 0;
  return Number(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true),
  );
}

export function encodeStats(s: Bm25Stats): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(s.docs), true);
  view.setBigUint64(8, BigInt(s.totalLength), true);
  return out;
}

/** Missing stats are an empty scope. */
export function decodeStats(bytes: Uint8Array | undefined): Bm25Stats {
  if (!bytes) return { docs: 0, totalLength: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    docs: Number(view.getBigUint64(0, true)),
    totalLength: Number(view.getBigUint64(8, true)),
  };
}
