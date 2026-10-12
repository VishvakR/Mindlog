import type { KvHeader } from '@mindlog/proto';
import { Tag, elementKey, elementPrefix } from '../../model/kv-keys.js';
import type { Keyspace } from '../../model/keyspace.js';

/**
 * Sequence-numbered list elements (PLAN 5.2): the header keeps
 * `[listHead, listTail)`, so index i lives at seq `listHead + i`.
 */
export class ListOps {
  constructor(
    private readonly ks: Keyspace,
    private readonly name: Uint8Array,
    readonly header: KvHeader,
  ) {}

  get length(): bigint {
    return this.header.listTail - this.header.listHead;
  }

  private key(seq: bigint): Uint8Array {
    return elementKey(this.ks.tenant, this.name, this.header.generation, Tag.LIST, seq);
  }

  /** Index (negative counts from the end) → seq, or undefined when out of range. */
  seqOf(index: bigint): bigint | undefined {
    const i = index < 0n ? this.length + index : index;
    return i < 0n || i >= this.length ? undefined : this.header.listHead + i;
  }

  get(seq: bigint): Promise<Uint8Array | undefined> {
    return this.ks.context.view.get(this.key(seq));
  }

  set(seq: bigint, value: Uint8Array): void {
    this.ks.writer.put(this.key(seq), value);
  }

  pushLeft(value: Uint8Array): void {
    this.header.listHead--;
    this.set(this.header.listHead, value);
    this.header.count = this.length;
  }

  pushRight(value: Uint8Array): void {
    this.set(this.header.listTail, value);
    this.header.listTail++;
    this.header.count = this.length;
  }

  async popLeft(): Promise<Uint8Array | undefined> {
    if (this.length === 0n) return undefined;
    const value = await this.get(this.header.listHead);
    this.ks.writer.delete(this.key(this.header.listHead));
    this.header.listHead++;
    this.header.count = this.length;
    return value;
  }

  async popRight(): Promise<Uint8Array | undefined> {
    if (this.length === 0n) return undefined;
    this.header.listTail--;
    const value = await this.get(this.header.listTail);
    this.ks.writer.delete(this.key(this.header.listTail));
    this.header.count = this.length;
    return value;
  }

  /** Values for seqs in `[from, to]`, in order. */
  async range(from: bigint, to: bigint): Promise<Uint8Array[]> {
    if (from > to) return [];
    const prefix = elementPrefix(this.ks.tenant, this.name, this.header.generation, Tag.LIST);
    const out: Uint8Array[] = [];
    const options = { after: this.key(from - 1n), before: this.key(to + 1n) };
    for await (const entry of this.ks.context.view.scan(prefix, options)) out.push(entry.value);
    return out;
  }

  /** Keeps only seqs in `[from, to]`, deleting the rest. */
  trim(from: bigint, to: bigint): void {
    const { listHead, listTail } = this.header;
    const keepFrom = from > to ? listTail : from;
    const keepTo = from > to ? listTail - 1n : to;
    for (let seq = listHead; seq < keepFrom; seq++) this.ks.writer.delete(this.key(seq));
    for (let seq = keepTo + 1n; seq < listTail; seq++) this.ks.writer.delete(this.key(seq));
    this.header.listHead = keepFrom;
    this.header.listTail = keepTo + 1n;
    this.header.count = this.length;
  }
}
