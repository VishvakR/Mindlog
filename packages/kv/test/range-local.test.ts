import { create, fromBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { SYSTEM_TENANT, keyPrefix, prefixRange } from '@mindlog/core';
import { createKvRegistry, headerKey } from '@mindlog/kv';
import { KvHeaderSchema, RangeDescriptorSchema } from '@mindlog/proto';
import { rangeLocalPrefix } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import { kvNode } from './support/kv-node.js';

const utf8 = new TextEncoder();

async function count(store: KvReader, prefix: Uint8Array): Promise<number> {
  let n = 0;
  for await (const _ of store.iterate(prefixRange(prefix))) n++;
  return n;
}

const systemPrefix = (() => {
  const p = keyPrefix(SYSTEM_TENANT, 's');
  if (!p.ok) throw new Error(p.error.message);
  return p.value;
})();

describe('range-local KV state (ADR-0028, ADR-0029)', () => {
  test('a write to a key outside the range fails with RANGE_MOVED', async () => {
    const descriptor = create(RangeDescriptorSchema, {
      rangeId: 1n,
      endKey: headerKey('t', utf8.encode('m')),
    });
    const node = await kvNode(createKvRegistry(), undefined, descriptor);
    expect(await node.run('SET', 'a', '1')).toBe('OK');
    const moved = { error: 'RANGE_MOVED key is not in range 1' };
    expect(await node.run('SET', 'z', '1')).toEqual(moved);
    expect(await node.run('MSET', 'b', '1', 'y', '2')).toEqual(moved);
    expect(await node.run('GET', 'b')).toBeNull();
  });

  test('expiry entries live with the range, not in the system tenant', async () => {
    const node = await kvNode(createKvRegistry());
    await node.run('SET', 'k', 'v', 'PX', '100000');
    expect(await count(node.store, rangeLocalPrefix(1n, 'expire'))).toBe(1);
    expect(await count(node.store, systemPrefix)).toBe(0);
  });

  test('dead generations live with the range, and generations are versions', async () => {
    const node = await kvNode(createKvRegistry());
    await node.run('HSET', 'h', 'f', 'v');
    const stored = await new MvccReader(node.store).get(headerKey('t', utf8.encode('h')));
    expect(stored && fromBinary(KvHeaderSchema, stored).generation).toBe(node.machine.lastVersion);
    await node.run('DEL', 'h');
    expect(await count(node.store, rangeLocalPrefix(1n, 'deadgen'))).toBe(1);
    expect(await count(node.store, systemPrefix)).toBe(0);
  });
});
