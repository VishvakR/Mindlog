import type { BlobStore } from '@mindlog/blob';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { MemoryRecord } from '@mindlog/proto';
import type { ColdEntry } from '../cold-segment.js';
import { decodeSegment } from '../cold-segment.js';

/**
 * Reads cold records back from their blob segments (PLAN 10.4, ADR-0033), on
 * the leader only. Keeps the last few decoded segments, since one recall
 * often hits several memories that went cold together.
 */
export class ColdReads {
  readonly #blob: BlobStore;
  readonly #max: number;
  readonly #segments = new Map<string, Map<string, ColdEntry>>();

  constructor(blob: BlobStore, maxSegments = 16) {
    this.#blob = blob;
    this.#max = maxSegments;
  }

  /** The full record of a cold stub, with its vector; an error when the segment is gone or altered. */
  async entry(stub: MemoryRecord): Promise<Result<ColdEntry, MindlogError>> {
    const key = stub.coldSegment;
    let entries = this.#segments.get(key);
    if (!entries) {
      const bytes = await this.#blob.get(key);
      if (!bytes.ok) return bytes;
      if (!bytes.value) return err(mindlogError('NOT_FOUND', `cold segment ${key} is missing`));
      const decoded = decodeSegment(bytes.value, stub.coldSha256);
      if (!decoded) return err(mindlogError('INTERNAL', `cold segment ${key} fails its checksum`));
      entries = new Map(decoded.map((e) => [e.record.id, e]));
      this.#segments.set(key, entries);
      while (this.#segments.size > this.#max) {
        const oldest = this.#segments.keys().next().value;
        if (oldest === undefined) break;
        this.#segments.delete(oldest);
      }
    }
    const entry = entries.get(stub.id);
    return entry ? ok(entry) : err(mindlogError('NOT_FOUND', `memory ${stub.id} is not in ${key}`));
  }
}
