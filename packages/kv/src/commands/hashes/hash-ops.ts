import type { KvHeader } from '@mindlog/proto';
import { lastElement } from '../../model/element-name.js';
import { Tag, elementKey, elementPrefix } from '../../model/kv-keys.js';
import type { Keyspace } from '../../model/keyspace.js';

/** Field-level access to one hash's current generation. */
export class HashOps {
  constructor(
    private readonly ks: Keyspace,
    private readonly name: Uint8Array,
    private readonly header: KvHeader,
  ) {}

  private key(field: Uint8Array): Uint8Array {
    return elementKey(this.ks.tenant, this.name, this.header.generation, Tag.HASH, field);
  }

  get(field: Uint8Array): Promise<Uint8Array | undefined> {
    return this.ks.context.view.get(this.key(field));
  }

  /** Sets a field; returns true if it is new (and bumps the count). */
  async set(field: Uint8Array, value: Uint8Array): Promise<boolean> {
    const isNew = (await this.get(field)) === undefined;
    this.ks.writer.put(this.key(field), value);
    if (isNew) this.header.count++;
    return isNew;
  }

  /** Removes a field; returns true if it existed. */
  async delete(field: Uint8Array): Promise<boolean> {
    if ((await this.get(field)) === undefined) return false;
    this.ks.writer.delete(this.key(field));
    this.header.count--;
    return true;
  }

  /** Fields and values in field order, optionally after a field. */
  async *entries(after?: Uint8Array): AsyncGenerator<readonly [Uint8Array, Uint8Array]> {
    const prefix = elementPrefix(this.ks.tenant, this.name, this.header.generation, Tag.HASH);
    const options = after ? { after: this.key(after) } : {};
    for await (const entry of this.ks.context.view.scan(prefix, options)) {
      yield [lastElement(entry.key), entry.value] as const;
    }
  }
}
