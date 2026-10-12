import type { KvHeader } from '@mindlog/proto';
import { lastElement } from '../../model/element-name.js';
import { Tag, elementKey, elementPrefix } from '../../model/kv-keys.js';
import type { Keyspace } from '../../model/keyspace.js';

const EMPTY = new Uint8Array();

/** Member-level access to one set's current generation. */
export class SetOps {
  constructor(
    private readonly ks: Keyspace,
    private readonly name: Uint8Array,
    readonly header: KvHeader,
  ) {}

  private key(member: Uint8Array): Uint8Array {
    return elementKey(this.ks.tenant, this.name, this.header.generation, Tag.SET, member);
  }

  async has(member: Uint8Array): Promise<boolean> {
    return (await this.ks.context.view.get(this.key(member))) !== undefined;
  }

  async add(member: Uint8Array): Promise<boolean> {
    if (await this.has(member)) return false;
    this.ks.writer.put(this.key(member), EMPTY);
    this.header.count++;
    return true;
  }

  async remove(member: Uint8Array): Promise<boolean> {
    if (!(await this.has(member))) return false;
    this.ks.writer.delete(this.key(member));
    this.header.count--;
    return true;
  }

  /** Members in byte order, optionally after one. */
  async *members(after?: Uint8Array): AsyncGenerator<Uint8Array> {
    const prefix = elementPrefix(this.ks.tenant, this.name, this.header.generation, Tag.SET);
    for await (const entry of this.ks.context.view.scan(
      prefix,
      after ? { after: this.key(after) } : {},
    )) {
      yield lastElement(entry.key);
    }
  }

  async all(): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for await (const member of this.members()) out.push(member);
    return out;
  }
}
