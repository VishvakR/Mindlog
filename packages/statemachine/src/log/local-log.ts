import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { crc32c, decodeKey } from '@mindlog/core';
import type { Command } from '@mindlog/proto';
import { CommandSchema } from '@mindlog/proto';
import type { KvStore } from '@mindlog/storage';
import { logEntryKey, logPrefix } from '../system/system-keys.js';

const CHECKSUM_BYTES = 4;

function frame(command: Command): Uint8Array {
  const payload = toBinary(CommandSchema, command);
  const out = new Uint8Array(CHECKSUM_BYTES + payload.length);
  new DataView(out.buffer).setUint32(0, crc32c(payload));
  out.set(payload, CHECKSUM_BYTES);
  return out;
}

/** Decodes a stored entry; a checksum mismatch is corruption and throws. */
function unframe(index: bigint, stored: Uint8Array): Command {
  if (stored.length < CHECKSUM_BYTES) throw new Error(`log entry ${index} is corrupt (truncated)`);
  const payload = stored.subarray(CHECKSUM_BYTES);
  const expected = new DataView(stored.buffer, stored.byteOffset, CHECKSUM_BYTES).getUint32(0);
  if (crc32c(payload) !== expected) {
    throw new Error(`log entry ${index} is corrupt (checksum mismatch)`);
  }
  return fromBinary(CommandSchema, payload);
}

function indexOf(key: Uint8Array): bigint {
  const decoded = decodeKey(key);
  const index = decoded.ok ? decoded.value.tuple[2] : undefined;
  if (typeof index !== 'bigint') throw new Error('malformed log entry key');
  return index;
}

/**
 * Single-node command log in the log store (ADR-0005), standing in for the Raft
 * log until phase 3. Appends are fsynced before they resolve; every entry
 * carries a CRC-32C checksum.
 */
export class LocalLog {
  readonly #store: KvStore;
  readonly #rangeId: bigint;
  #first: bigint;
  #last: bigint;

  private constructor(store: KvStore, rangeId: bigint, first: bigint, last: bigint) {
    this.#store = store;
    this.#rangeId = rangeId;
    this.#first = first;
    this.#last = last;
  }

  static async open(store: KvStore, rangeId = 1n): Promise<LocalLog> {
    const prefix = logPrefix(rangeId);
    const range = { start: prefix, end: new Uint8Array([...prefix, 0xff]) };
    let first = 0n;
    let last = 0n;
    for await (const [key] of store.iterate(range, { limit: 1 })) first = indexOf(key);
    for await (const [key] of store.iterate(range, { limit: 1, reverse: true }))
      last = indexOf(key);
    return new LocalLog(store, rangeId, first === 0n ? last + 1n : first, last);
  }

  /** Index of the first retained entry (last + 1 when empty). */
  get firstIndex(): bigint {
    return this.#first;
  }

  get lastIndex(): bigint {
    return this.#last;
  }

  /** Appends with one fsync and returns the assigned indexes. */
  async append(commands: readonly Command[]): Promise<bigint[]> {
    const batch = this.#store.batch();
    const indexes = commands.map((command, i) => {
      const index = this.#last + 1n + BigInt(i);
      batch.put(logEntryKey(this.#rangeId, index), frame(command));
      return index;
    });
    await batch.write({ sync: true });
    this.#last += BigInt(commands.length);
    return indexes;
  }

  /** Entries in `[from, to]` (default to the last index), in order. */
  async *entries(from: bigint, to = this.#last): AsyncGenerator<readonly [bigint, Command]> {
    if (from > to) return;
    const range = {
      start: logEntryKey(this.#rangeId, from),
      end: logEntryKey(this.#rangeId, to + 1n),
    };
    let expected = from;
    for await (const [key, value] of this.#store.iterate(range)) {
      const index = indexOf(key);
      if (index !== expected) throw new Error(`log gap: expected ${expected}, found ${index}`);
      yield [index, unframe(index, value)] as const;
      expected++;
    }
    if (expected <= to) throw new Error(`log entries ${expected}..${to} are missing`);
  }

  /** Deletes entries up to and including `upTo`; callers ensure state is durable first. */
  async compact(upTo: bigint): Promise<void> {
    const end = upTo > this.#last ? this.#last : upTo;
    if (end < this.#first) return;
    const batch = this.#store.batch();
    for (let i = this.#first; i <= end; i++) batch.del(logEntryKey(this.#rangeId, i));
    await batch.write({ sync: true });
    this.#first = end + 1n;
  }
}
