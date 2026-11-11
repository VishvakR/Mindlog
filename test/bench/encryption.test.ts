import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeKey } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import { EncryptingStore, LevelDbStore } from '@mindlog/storage';
import { expect, test } from 'vitest';

/**
 * ADR-0014: the cost of encryption at rest on writes and reads, LevelDB with
 * and without the decorator. Opt-in: `BENCH=1 pnpm vitest run test/bench/encryption.test.ts`.
 */
const N = Number(process.env.BENCH_N ?? 50_000);
const BATCH = 100;
const VALUE = randomBytes(200);

async function run(store: KvStore) {
  const keys = Array.from({ length: N }, (_, i) => {
    const k = encodeKey({ tenant: 'acme', family: 'k', tuple: [`key-${String(i)}`] });
    if (!k.ok) throw new Error(k.error.message);
    return k.value;
  });
  let start = performance.now();
  for (let i = 0; i < N; i += BATCH) {
    const batch = store.batch();
    for (const k of keys.slice(i, i + BATCH)) batch.put(k, VALUE);
    await batch.write();
  }
  const writeMs = performance.now() - start;
  start = performance.now();
  for (const k of keys) await store.get(k);
  return { writeUs: (writeMs * 1000) / N, readUs: ((performance.now() - start) * 1000) / N };
}

test.runIf(process.env.BENCH === '1')('encryption overhead', { timeout: 300_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mindlog-bench-enc-'));
  try {
    const plain = await LevelDbStore.open(join(dir, 'plain'));
    const raw = await LevelDbStore.open(join(dir, 'sealed'));
    if (!plain.ok || !raw.ok) throw new Error('open');
    const sealed = await EncryptingStore.open(raw.value, new Uint8Array(randomBytes(32)), 'bench');
    if (!sealed.ok) throw new Error(sealed.error.message);
    const a = await run(plain.value);
    const b = await run(sealed.value);
    console.log(
      `encryption bench, ${String(N)} × 200 B values, batches of ${String(BATCH)}:\n` +
        `  plaintext  write ${a.writeUs.toFixed(2)} µs/value, read ${a.readUs.toFixed(2)} µs/value\n` +
        `  encrypted  write ${b.writeUs.toFixed(2)} µs/value, read ${b.readUs.toFixed(2)} µs/value`,
    );
    expect(b.writeUs).toBeGreaterThan(0);
    await Promise.all([plain.value.close(), sealed.value.close()]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
