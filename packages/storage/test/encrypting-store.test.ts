import { randomBytes } from 'node:crypto';
import { encodeKey } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import { EncryptingStore, MemoryStore, rewrapKeyring } from '@mindlog/storage';
import { describe, expect, test } from 'vitest';
import { describeKvStoreContract } from './contracts/kv-store-contract.js';

const master = () => new Uint8Array(randomBytes(32));
const text = (s: string) => new TextEncoder().encode(s);
const key = (tenant: string, name: string) => {
  const k = encodeKey({ tenant, family: 'k', tuple: [name] });
  if (!k.ok) throw new Error(k.error.message);
  return k.value;
};

async function encrypted(inner: KvStore = new MemoryStore(), m = master()) {
  const opened = await EncryptingStore.open(inner, m, 'state');
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value as EncryptingStore;
}

async function put(store: KvStore, k: Uint8Array, v: string) {
  const batch = store.batch();
  batch.put(k, text(v));
  await batch.write();
}

async function rawValues(inner: MemoryStore): Promise<string> {
  let all = '';
  for await (const [, v] of inner.iterate({ start: new Uint8Array(), end: Uint8Array.of(0xff) }))
    all += Buffer.from(v).toString('latin1');
  return all;
}

describeKvStoreContract('EncryptingStore over MemoryStore', () => encrypted());

describe('EncryptingStore', () => {
  test('stores no plaintext value and hides its own rows', async () => {
    const inner = new MemoryStore();
    const store = await encrypted(inner);
    await put(store, key('acme', 'a'), 'a very secret value');
    expect(await rawValues(inner)).not.toContain('a very secret value');
    const seen: Uint8Array[] = [];
    for await (const [k] of store.iterate({ start: new Uint8Array(), end: Uint8Array.of(0xff) }))
      seen.push(k);
    expect(seen).toEqual([key('acme', 'a')]);
  });

  test('a value moved to another key does not open', async () => {
    const inner = new MemoryStore();
    const store = await encrypted(inner);
    await put(store, key('acme', 'a'), 'x');
    const sealed = await inner.get(key('acme', 'a'));
    const batch = inner.batch();
    batch.put(key('acme', 'b'), sealed as Uint8Array);
    await batch.write();
    await expect(store.get(key('acme', 'b'))).rejects.toThrow();
  });

  test('reopens with the master key; refuses another key, no key, or plaintext data', async () => {
    const inner = new MemoryStore();
    const m = master();
    await put(await encrypted(inner, m), key('acme', 'a'), 'v');
    const again = await encrypted(inner, m);
    expect(await again.get(key('acme', 'a'))).toEqual(text('v'));
    expect((await EncryptingStore.open(inner, master(), 'state')).ok).toBe(false);
    expect((await EncryptingStore.open(inner, undefined, 'state')).ok).toBe(false);
    const plain = new MemoryStore();
    await put(plain, key('acme', 'a'), 'v');
    expect((await EncryptingStore.open(plain, m, 'state')).ok).toBe(false);
    expect((await EncryptingStore.open(plain, undefined, 'state')).ok).toBe(true);
  });

  test('a new data key reaches disk with the first batch that is written', async () => {
    const inner = new MemoryStore();
    const m = master();
    const store = await encrypted(inner, m);
    store.batch().put(key('acme', 'lost'), text('never written'));
    await put(store, key('acme', 'kept'), 'v');
    const reopened = await encrypted(inner, m);
    expect(await reopened.get(key('acme', 'kept'))).toEqual(text('v'));
  });

  test('each tenant has its own key, and forgetting it shreds only that tenant', async () => {
    const store = await encrypted();
    await put(store, key('acme', 'a'), 'A');
    await put(store, key('globex', 'a'), 'G');
    expect(store.scopes().sort()).toEqual(['acme', 'globex']);
    await store.forget('acme');
    await expect(store.get(key('acme', 'a'))).rejects.toThrow(/no data key/);
    expect(await store.get(key('globex', 'a'))).toEqual(text('G'));
  });

  test('rotating the master key re-wraps the keyring', async () => {
    const inner = new MemoryStore();
    const [oldKey, newKey] = [master(), master()];
    await put(await encrypted(inner, oldKey), key('acme', 'a'), 'v');
    const rewrapped = await rewrapKeyring(inner, oldKey, newKey);
    expect(rewrapped).toEqual({ ok: true, value: 1 });
    expect((await EncryptingStore.open(inner, oldKey, 'state')).ok).toBe(false);
    expect(await (await encrypted(inner, newKey)).get(key('acme', 'a'))).toEqual(text('v'));
  });

  test('snapshots decrypt and keep their view', async () => {
    const store = await encrypted();
    await put(store, key('acme', 'a'), 'old');
    const snap = await store.snapshot();
    await put(store, key('acme', 'a'), 'new');
    expect(await snap.get(key('acme', 'a'))).toEqual(text('old'));
    await snap.release();
  });
});
