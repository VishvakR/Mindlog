import { expect, test } from 'vitest';
import type { BlobStore } from '@mindlog/blob';

/** The behaviour every `BlobStore` shares (CLAUDE.md 3.3). */
export function blobContract(name: string, open: () => Promise<BlobStore>, prefix = ''): void {
  const bytes = (s: string) => new TextEncoder().encode(s);
  test(`${name}: put, get, overwrite and delete`, async () => {
    const store = await open();
    const key = `${prefix}cold/acme/u1/seg-1.json.gz`;
    expect(await store.get(key)).toEqual({ ok: true, value: undefined });
    expect((await store.put(key, bytes('one'))).ok).toBe(true);
    expect(await store.get(key)).toEqual({ ok: true, value: bytes('one') });
    expect((await store.put(key, bytes('two'))).ok).toBe(true);
    expect(await store.get(key)).toEqual({ ok: true, value: bytes('two') });
    expect((await store.delete(key)).ok).toBe(true);
    expect(await store.get(key)).toEqual({ ok: true, value: undefined });
    expect((await store.delete(key)).ok).toBe(true);
  });

  test(`${name}: binary bytes round-trip`, async () => {
    const store = await open();
    const data = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    expect((await store.put(`${prefix}bin/x`, data)).ok).toBe(true);
    expect(await store.get(`${prefix}bin/x`)).toEqual({ ok: true, value: data });
  });

  test(`${name}: unsafe keys are refused`, async () => {
    const store = await open();
    for (const key of ['', '../x', 'a/../b', '/abs', 'a//b', 'sp ace', 'a/./b'])
      expect((await store.put(key, bytes('x'))).ok).toBe(false);
  });
}
