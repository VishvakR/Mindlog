import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { decodeKey } from '@mindlog/core';
import type { CommandResult } from '@mindlog/proto';
import { CommandResultSchema } from '@mindlog/proto';
import type { KvReader, WriteBatch } from '@mindlog/storage';
import { idempotencyAgeKey, idempotencyAgePrefix, idempotencyKey } from './system-keys.js';

/**
 * Results of applied requests by request id (PLAN 6.2), so a client retry
 * after a timeout gets the original result instead of applying twice.
 * Commands without a request id are not recorded. Records are kept for a
 * retention window and then removed by a replicated GC command. Each range
 * has its own table (ADR-0028), so it moves with the range's snapshots.
 */
export class IdempotencyTable {
  readonly #reader: KvReader;
  readonly #rangeId: bigint;

  constructor(reader: KvReader, rangeId: bigint) {
    this.#reader = reader;
    this.#rangeId = rangeId;
  }

  async lookup(requestId: Uint8Array): Promise<CommandResult | undefined> {
    if (requestId.length === 0) return undefined;
    const stored = await this.#reader.get(idempotencyKey(this.#rangeId, requestId));
    return stored ? fromBinary(CommandResultSchema, stored) : undefined;
  }

  record(batch: WriteBatch, requestId: Uint8Array, result: CommandResult, version: bigint): void {
    if (requestId.length === 0) return;
    batch.put(idempotencyKey(this.#rangeId, requestId), toBinary(CommandResultSchema, result));
    batch.put(idempotencyAgeKey(this.#rangeId, version, requestId), new Uint8Array());
  }

  /** Drops records applied at versions below `belowVersion`, oldest first, at most `limit`. */
  static async collect(
    raw: { readonly reader: KvReader; readonly batch: WriteBatch },
    rangeId: bigint,
    belowVersion: bigint,
    limit: number,
  ): Promise<number> {
    const prefix = idempotencyAgePrefix(rangeId);
    let removed = 0;
    for await (const [key] of raw.reader.iterate({
      start: prefix,
      end: new Uint8Array([...prefix, 0xff]),
    })) {
      const decoded = decodeKey(key);
      const [, , , version, requestId] = decoded.ok ? decoded.value.tuple : [];
      if (typeof version !== 'bigint' || !(requestId instanceof Uint8Array)) continue;
      if (version >= belowVersion || removed >= limit) break;
      raw.batch.del(key);
      raw.batch.del(idempotencyKey(rangeId, requestId));
      removed++;
    }
    return removed;
  }
}
