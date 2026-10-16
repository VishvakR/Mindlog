import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { crc32c, decodeKey, prefixRange } from '@mindlog/core';
import type { Entry, HardState } from '@mindlog/proto';
import { EntrySchema, HardStateSchema, TruncatedStateSchema } from '@mindlog/proto';
import type { KvStore } from '@mindlog/storage';
import { logEntryKey, logPrefix, raftStateKey, raftTruncatedKey } from '../system/system-keys.js';

const CHECKSUM_BYTES = 4;

function frame<D extends DescMessage>(schema: D, message: MessageShape<D>): Uint8Array {
  const payload = toBinary(schema, message);
  const out = new Uint8Array(CHECKSUM_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, crc32c(payload));
  out.set(payload, CHECKSUM_BYTES);
  return out;
}

/** Decodes a stored record; a checksum mismatch is corruption and throws (PLAN 7.3). */
function unframe<D extends DescMessage>(
  schema: D,
  what: string,
  stored: Uint8Array,
): MessageShape<D> {
  if (stored.length < CHECKSUM_BYTES) throw new Error(`${what} is corrupt (truncated)`);
  const payload = stored.subarray(CHECKSUM_BYTES);
  const expected = new DataView(stored.buffer, stored.byteOffset, CHECKSUM_BYTES).getUint32(0);
  if (crc32c(payload) !== expected) throw new Error(`${what} is corrupt (checksum mismatch)`);
  return fromBinary(schema, payload);
}

function indexOf(key: Uint8Array): bigint {
  const decoded = decodeKey(key);
  const index = decoded.ok ? decoded.value.tuple[2] : undefined;
  if (typeof index !== 'bigint') throw new Error('malformed log entry key');
  return index;
}

export interface TruncatedPoint {
  readonly index: bigint;
  readonly term: bigint;
}

/** What a range's log store holds (ADR-0026). */
export interface StoredLog {
  readonly hardState: HardState;
  readonly truncated: TruncatedPoint;
  readonly entries: Entry[];
}

/** One Ready cycle's writes to the log store. */
export interface LogUpdate {
  readonly hardState?: HardState;
  /** Contiguous; replaces every stored entry from the first one's index on. */
  readonly entries: readonly Entry[];
  /** A snapshot replaced the log: drop every entry and record this point. */
  readonly snapshot?: TruncatedPoint;
  readonly sync: boolean;
}

/**
 * The Raft log of one range in the dedicated log store (ADR-0005, ADR-0026):
 * CRC-framed entries, hard state and truncated state. Each update is one
 * batch, so a Ready cycle costs one fsync (group commit).
 */
export class RaftLogStore {
  readonly #store: KvStore;
  readonly #rangeId: bigint;
  #first = 1n;
  #last = 0n;

  constructor(store: KvStore, rangeId = 1n) {
    this.#store = store;
    this.#rangeId = rangeId;
  }

  get rangeId(): bigint {
    return this.#rangeId;
  }

  /** Reads everything back on start; throws on corruption or a gap. */
  async load(): Promise<StoredLog> {
    const hard = await this.#store.get(raftStateKey(this.#rangeId));
    const truncatedBytes = await this.#store.get(raftTruncatedKey(this.#rangeId));
    const hardState = hard
      ? unframe(HardStateSchema, 'raft hard state', hard)
      : create(HardStateSchema, {});
    const t = truncatedBytes
      ? unframe(TruncatedStateSchema, 'raft truncated state', truncatedBytes)
      : undefined;
    const truncated = { index: t?.index ?? 0n, term: t?.term ?? 0n };
    const entries: Entry[] = [];
    let expected = truncated.index + 1n;
    for await (const [key, value] of this.#store.iterate(prefixRange(logPrefix(this.#rangeId)))) {
      const index = indexOf(key);
      const entry = unframe(EntrySchema, `log entry ${index}`, value);
      if (index !== expected || entry.index !== index)
        throw new Error(`log gap: expected entry ${expected}, found ${index}`);
      entries.push(entry);
      expected++;
    }
    this.#first = truncated.index + 1n;
    this.#last = truncated.index + BigInt(entries.length);
    return { hardState, truncated, entries };
  }

  async persist(update: LogUpdate): Promise<void> {
    const batch = this.#store.batch();
    if (update.snapshot) {
      for (let i = this.#first; i <= this.#last; i++) batch.del(logEntryKey(this.#rangeId, i));
      this.#putTruncated(batch, update.snapshot);
      this.#first = update.snapshot.index + 1n;
      this.#last = update.snapshot.index;
    }
    const first = update.entries[0];
    if (first) {
      for (let i = first.index; i <= this.#last; i++) batch.del(logEntryKey(this.#rangeId, i));
      for (const entry of update.entries)
        batch.put(logEntryKey(this.#rangeId, entry.index), frame(EntrySchema, entry));
      this.#last = first.index + BigInt(update.entries.length) - 1n;
    }
    if (update.hardState)
      batch.put(raftStateKey(this.#rangeId), frame(HardStateSchema, update.hardState));
    if (batch.length > 0) await batch.write({ sync: update.sync });
  }

  /** Removes entries up to `point.index` (state must be flushed past it, ADR-0005). */
  async compact(point: TruncatedPoint): Promise<void> {
    if (point.index < this.#first) return;
    const batch = this.#store.batch();
    for (let i = this.#first; i <= point.index && i <= this.#last; i++)
      batch.del(logEntryKey(this.#rangeId, i));
    this.#putTruncated(batch, point);
    await batch.write({ sync: true });
    this.#first = point.index + 1n;
    if (this.#last < point.index) this.#last = point.index;
  }

  #putTruncated(batch: ReturnType<KvStore['batch']>, point: TruncatedPoint): void {
    batch.put(
      raftTruncatedKey(this.#rangeId),
      frame(TruncatedStateSchema, create(TruncatedStateSchema, point)),
    );
  }
}
