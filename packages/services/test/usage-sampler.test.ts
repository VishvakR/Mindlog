import type { KeyRange, Tuple } from '@mindlog/core';
import { KeyFamily, encodeKey, err, mindlogError, ok } from '@mindlog/core';
import { MemoryStore, versionedKey } from '@mindlog/storage';
import { expect, test } from 'vitest';
import type { TenantInfo } from '../src/index.js';
import { UsageSampler } from '../src/index.js';

const WHOLE: KeyRange = { start: new Uint8Array([0]), end: new Uint8Array([0xff, 0xff]) };

function key(tenant: string, family: KeyFamily, tuple: Tuple, version = 1n): Uint8Array {
  const encoded = encodeKey({ tenant, family, tuple });
  if (!encoded.ok) throw new Error(encoded.error.message);
  return versionedKey(encoded.value, version);
}

async function store(): Promise<MemoryStore> {
  const s = new MemoryStore();
  const b = s.batch();
  const v = new Uint8Array([1]);
  for (const t of ['acme', 'globex']) {
    b.put(key(t, KeyFamily.KV, ['a'], 1n), v);
    b.put(key(t, KeyFamily.KV, ['a'], 2n), v); // a second version is still one key
    b.put(key(t, KeyFamily.KV, ['b']), v);
    b.put(key(t, KeyFamily.KV, ['list', 1n]), v); // an element row, not a key
    b.put(key(t, KeyFamily.MEMORY, ['u', 'r', 'm1']), v);
    b.put(key(t, KeyFamily.MEMORY, ['u', 'r', 'm2']), v);
    b.put(key(t, KeyFamily.MEMORY, ['u', 'v', 'm1']), v); // an index row, not a memory
  }
  await b.write();
  return s;
}

const tenant = (name: string, quotas: TenantInfo['quotas']) => ({ name, quotas }) as TenantInfo;

test('counts each tenant’s keys and memories once, and sizes its spans', async () => {
  const sized: KeyRange[] = [];
  const sampler = new UsageSampler({
    tenants: () =>
      Promise.resolve(
        ok([
          tenant('acme', { keys: 10, storageBytes: 1000 }),
          tenant('globex', { memories: 5 }),
          tenant('free', {}),
        ]),
      ),
    leaderSpans: () => [WHOLE],
    state: await store(),
    sizer: (start, end) => {
      sized.push({ start, end });
      return Promise.resolve(42);
    },
  });
  const usage = await sampler.sample();
  expect(usage.get('acme')).toEqual({ bytes: 42, keys: 2, memories: 2 });
  // No storage quota: no sizing.
  expect(usage.get('globex')).toEqual({ bytes: 0, keys: 2, memories: 2 });
  // No storage-shaped quota at all: not measured.
  expect(usage.has('free')).toBe(false);
  expect(sized).toHaveLength(1);
});

test('only spans this node leads are measured', async () => {
  const sampler = new UsageSampler({
    tenants: () => Promise.resolve(ok([tenant('acme', { keys: 10 })])),
    leaderSpans: () => [{ start: new Uint8Array([0]), end: new Uint8Array([1]) }],
    state: await store(),
    sizer: () => Promise.resolve(0),
  });
  expect((await sampler.sample()).get('acme')).toEqual({ bytes: 0, keys: 0, memories: 0 });
});

test('the walk stops at maxKeys, so a big tenant is under-counted, not slow', async () => {
  const sampler = new UsageSampler({
    tenants: () => Promise.resolve(ok([tenant('acme', { keys: 10 })])),
    leaderSpans: () => [WHOLE],
    state: await store(),
    sizer: () => Promise.resolve(0),
    maxKeys: 2,
  });
  const counted = (await sampler.sample()).get('acme');
  expect((counted?.keys ?? 0) + (counted?.memories ?? 0)).toBeLessThan(4);
});

test('no registry answer, or an unusable tenant name, measures nothing', async () => {
  const state = await store();
  const failing = new UsageSampler({
    tenants: () => Promise.resolve(err(mindlogError('UNAVAILABLE', 'down'))),
    leaderSpans: () => [WHOLE],
    state,
    sizer: () => Promise.resolve(0),
  });
  expect((await failing.sample()).size).toBe(0);
  const badName = new UsageSampler({
    tenants: () => Promise.resolve(ok([tenant('', { keys: 1 })])),
    leaderSpans: () => [WHOLE],
    state,
    sizer: () => Promise.resolve(0),
  });
  expect((await badName.sample()).size).toBe(0);
});
