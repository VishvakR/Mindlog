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
 * retention window and then removed by a replicated GC command.
 */
export class IdempotencyTable {
  readonly #reader: KvReader;

  constructor(reader: KvReader) {
    this.#reader = reader;
  }

  async lookup(requestId: Uint8Array): Promise<CommandResult | undefined> {
    if (requestId.length === 0) return undefined;
    const stored = await this.#reader.get(idempotencyKey(requestId));
    return stored ? fromBinary(CommandResultSchema, stored) : undefined;
  }

  record(batch: WriteBatch, requestId: Uint8Array, result: CommandResult, index: bigint): void {
    if (requestId.length === 0) return;
    batch.put(idempotencyKey(requestId), toBinary(CommandResultSchema, result));
    batch.put(idempotencyAgeKey(index, requestId), new Uint8Array());
  }

  /** Drops records applied before `belowIndex`, oldest first, at most `limit`. */
  static async collect(
    raw: { readonly reader: KvReader; readonly batch: WriteBatch },
    belowIndex: bigint,
    limit: number,
  ): Promise<number> {
    const prefix = idempotencyAgePrefix();
    let removed = 0;
    for await (const [key] of raw.reader.iterate({
      start: prefix,
      end: new Uint8Array([...prefix, 0xff]),
    })) {
      const decoded = decodeKey(key);
      const [, index, requestId] = decoded.ok ? decoded.value.tuple : [];
      if (typeof index !== 'bigint' || !(requestId instanceof Uint8Array)) continue;
      if (index >= belowIndex || removed >= limit) break;
      raw.batch.del(key);
      raw.batch.del(idempotencyKey(requestId));
      removed++;
    }
    return removed;
  }
}
