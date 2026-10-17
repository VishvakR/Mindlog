import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { Random } from '@mindlog/core';
import type { WriteBatch } from '@mindlog/storage';
import type { KvHeader } from '@mindlog/proto';
import { KvHeaderSchema, KvType } from '@mindlog/proto';
import { deadGenerationKey, expiryIndexKey, headerKey } from './kv-keys.js';
import type { KvView, KvWriter } from './kv-view.js';

/** What a command may touch: one tenant's keyspace, as of one moment. */
export interface KeyspaceContext {
  readonly tenant: string;
  /** Current time: the command's HLC inside apply, the node clock for reads. */
  readonly nowMs: bigint;
  readonly view: KvView;
  /** Present only inside apply. */
  readonly writer?: KvWriter;
  /** MVCC version of the applying command (0 outside apply, ADR-0027). */
  readonly version: bigint;
  /** The range's own `$node` state (expiry index, dead generations); present only inside apply. */
  readonly local?: { readonly rangeId: bigint; readonly batch: WriteBatch };
  /** Index-seeded inside apply (SPOP); a system source for reads (SRANDMEMBER). */
  readonly random?: Random;
}

const isCollection = (type: KvType): boolean =>
  type === KvType.HASH || type === KvType.LIST || type === KvType.SET || type === KvType.ZSET;

/**
 * Header-level operations shared by every command: reading with lazy expiry,
 * writing (which stamps the version), deleting by generation, and keeping the
 * expiry index in sync (ADR-0022).
 */
export class Keyspace {
  constructor(readonly context: KeyspaceContext) {}

  get tenant(): string {
    return this.context.tenant;
  }

  get random(): Random {
    if (!this.context.random) throw new Error('no random source in this context');
    return this.context.random;
  }

  get local(): { readonly rangeId: bigint; readonly batch: WriteBatch } {
    if (!this.context.local) throw new Error('range-local write outside apply');
    return this.context.local;
  }

  get writer(): KvWriter {
    if (!this.context.writer) throw new Error('write outside apply');
    return this.context.writer;
  }

  /** True when an expiry time has passed (Valkey: expired once now > when). */
  expired(header: KvHeader): boolean {
    return header.expireAtMs !== 0n && this.context.nowMs > header.expireAtMs;
  }

  /** The live header, or undefined. Inside apply an expired key is deleted on the spot. */
  async header(name: Uint8Array): Promise<KvHeader | undefined> {
    const stored = await this.context.view.get(headerKey(this.tenant, name));
    if (!stored) return undefined;
    const header = fromBinary(KvHeaderSchema, stored);
    if (!this.expired(header)) return header;
    if (this.context.writer) this.delete(name, header);
    return undefined;
  }

  /**
   * Deletes a key whose stored expiry has passed (used by the expiry job's
   * command). Returns true if it was deleted.
   */
  async expireIfDue(name: Uint8Array): Promise<boolean> {
    const stored = await this.context.view.get(headerKey(this.tenant, name));
    if (!stored) return false;
    const header = fromBinary(KvHeaderSchema, stored);
    if (!this.expired(header)) return false;
    this.delete(name, header);
    return true;
  }

  /** A fresh header for a new key; its generation is the creating command's version. */
  fresh(type: KvType): KvHeader {
    return create(KvHeaderSchema, { type, generation: this.context.version });
  }

  /** Stores a header, stamping it with the current command's version. */
  write(name: Uint8Array, header: KvHeader): void {
    header.version = this.context.version;
    this.writer.put(headerKey(this.tenant, name), toBinary(KvHeaderSchema, header));
  }

  /** Deletes a key in O(1): drop the header, record a dead generation for GC. */
  delete(name: Uint8Array, header: KvHeader): void {
    this.writer.delete(headerKey(this.tenant, name));
    const { rangeId, batch } = this.local;
    if (header.expireAtMs !== 0n)
      batch.del(expiryIndexKey(rangeId, header.expireAtMs, this.tenant, name));
    if (isCollection(header.type)) {
      batch.put(
        deadGenerationKey(rangeId, this.context.version, this.tenant, name, header.generation),
        new Uint8Array(),
      );
    }
  }

  /** Sets (atMs > 0) or clears (0) a key's expiry, keeping the expiry index in sync. */
  setExpiry(name: Uint8Array, header: KvHeader, atMs: bigint): void {
    const { rangeId, batch } = this.local;
    if (header.expireAtMs !== 0n)
      batch.del(expiryIndexKey(rangeId, header.expireAtMs, this.tenant, name));
    header.expireAtMs = atMs;
    if (atMs !== 0n) batch.put(expiryIndexKey(rangeId, atMs, this.tenant, name), new Uint8Array());
  }
}
