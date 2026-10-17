import { fromBinary } from '@bufbuild/protobuf';
import { decodeKey, prefixRange } from '@mindlog/core';
import type { NodeInfo, Operator, RangeDescriptor } from '@mindlog/proto';
import { NodeInfoSchema, OperatorSchema, RangeDescriptorSchema } from '@mindlog/proto';
import type { KvReader } from '@mindlog/storage';
import { decodeU64 } from './pd-handlers.js';
import {
  nodePrefix,
  operatorPrefix,
  rangeEndKey,
  rangeEndPrefix,
  rangeKey,
  rangePrefix,
  tsoKey,
  versionKey,
} from './pd-keys.js';

/** Read side of the PD state machine: the directory, nodes, TSO bound, version and recent operators. */
export class PdView {
  readonly #reader: KvReader;

  constructor(reader: KvReader) {
    this.#reader = reader;
  }

  async nodes(): Promise<NodeInfo[]> {
    const out: NodeInfo[] = [];
    for await (const [, value] of this.#reader.iterate(prefixRange(nodePrefix())))
      out.push(fromBinary(NodeInfoSchema, value));
    return out;
  }

  async ranges(): Promise<RangeDescriptor[]> {
    const out: RangeDescriptor[] = [];
    for await (const [, value] of this.#reader.iterate(prefixRange(rangePrefix())))
      out.push(fromBinary(RangeDescriptorSchema, value));
    return out.sort(byStart);
  }

  async range(rangeId: bigint): Promise<RangeDescriptor | undefined> {
    const stored = await this.#reader.get(rangeKey(rangeId));
    return stored ? fromBinary(RangeDescriptorSchema, stored) : undefined;
  }

  /** The range whose span holds `key`: the first range ending after it. */
  async rangeFor(key: Uint8Array): Promise<RangeDescriptor | undefined> {
    const start = rangeEndKey(withZero(key), 0n);
    const end = prefixRange(rangeEndPrefix()).end;
    for await (const [index] of this.#reader.iterate({ start, end }, { limit: 1 })) {
      const decoded = decodeKey(index);
      const id = decoded.ok ? decoded.value.tuple.at(-1) : undefined;
      const range = typeof id === 'bigint' ? await this.range(id) : undefined;
      if (range && contains(range, key)) return range;
    }
    return undefined;
  }

  async tsoBound(): Promise<bigint> {
    return decodeU64(await this.#reader.get(tsoKey()));
  }

  async clusterVersion(): Promise<number> {
    return Number(decodeU64(await this.#reader.get(versionKey())));
  }

  /** Operators recorded by the leader, newest last. */
  async recentOperators(): Promise<Operator[]> {
    const out: Operator[] = [];
    for await (const [, value] of this.#reader.iterate(prefixRange(operatorPrefix())))
      out.push(fromBinary(OperatorSchema, value));
    return out;
  }
}

const byStart = (a: RangeDescriptor, b: RangeDescriptor): number => {
  const n = Math.min(a.startKey.length, b.startKey.length);
  for (let i = 0; i < n; i++) {
    const d = (a.startKey[i] ?? 0) - (b.startKey[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.startKey.length - b.startKey.length;
};

function withZero(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key.length + 1);
  out.set(key);
  return out;
}

export function contains(range: RangeDescriptor, key: Uint8Array): boolean {
  if (Buffer.compare(key, range.startKey) < 0) return false;
  return range.endKey.length === 0 || Buffer.compare(key, range.endKey) < 0;
}
