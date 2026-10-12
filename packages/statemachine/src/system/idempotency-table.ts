import { fromBinary, toBinary } from '@bufbuild/protobuf';
import type { CommandResult } from '@mindlog/proto';
import { CommandResultSchema } from '@mindlog/proto';
import type { KvReader, WriteBatch } from '@mindlog/storage';
import { idempotencyKey } from './system-keys.js';

/**
 * Results of applied requests by request id (PLAN 6.2), so a client retry
 * after a timeout gets the original result instead of applying twice.
 * Commands without a request id are not recorded.
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

  record(batch: WriteBatch, requestId: Uint8Array, result: CommandResult): void {
    if (requestId.length === 0) return;
    batch.put(idempotencyKey(requestId), toBinary(CommandResultSchema, result));
  }
}
