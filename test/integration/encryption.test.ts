import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLogger, MemoryMetrics, resolveConfig } from '@mindlog/core';
import { startNode } from '@mindlog/server';
import { Redis } from 'ioredis';
import { afterAll, expect, test } from 'vitest';

/** ADR-0014: values on disk are sealed; the master key is needed and checked on open. */

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function boot(dataDir: string, masterKey?: string) {
  const config = resolveConfig({
    flags: {
      node: { dataDir },
      listen: {
        resp: { host: '127.0.0.1', port: 0 },
        http: { host: '127.0.0.1', port: 0 },
        mcp: { http: { port: 0 } },
      },
      ...(masterKey ? { storage: { encryption: { masterKey } } } : {}),
    },
  });
  if (!config.ok) throw new Error(config.error.message);
  return startNode(config.value, { logger: new MemoryLogger(), metrics: new MemoryMetrics() });
}

async function rawBytes(dir: string): Promise<string> {
  let all = '';
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }))
    if (entry.isFile())
      all += (await readFile(join(entry.parentPath, entry.name))).toString('latin1');
  return all;
}

async function setAndGet(port: number, key: string, value?: string) {
  const client = new Redis({ port, lazyConnect: true, enableReadyCheck: false });
  await client.connect();
  if (value !== undefined) await client.set(key, value);
  const got = await client.get(key);
  client.disconnect();
  return got;
}

test('a planted value never reaches disk in plaintext, and the right key reopens it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mindlog-enc-'));
  dirs.push(dataDir);
  const master = randomBytes(32).toString('base64');
  const planted = `planted-${randomBytes(12).toString('hex')}`;
  const first = await boot(dataDir, master);
  if (!first.ok) throw new Error(first.error.message);
  expect(await setAndGet(first.value.resp.port, 'k', planted)).toBe(planted);
  await first.value.close();
  expect(await rawBytes(dataDir)).not.toContain(planted);

  expect((await boot(dataDir)).ok).toBe(false);
  expect((await boot(dataDir, randomBytes(32).toString('base64'))).ok).toBe(false);
  const again = await boot(dataDir, master);
  if (!again.ok) throw new Error(again.error.message);
  expect(await setAndGet(again.value.resp.port, 'k')).toBe(planted);
  await again.value.close();
});

test('without encryption the same check finds the value, so the check can fail', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mindlog-plain-'));
  dirs.push(dataDir);
  const planted = `planted-${randomBytes(12).toString('hex')}`;
  const node = await boot(dataDir);
  if (!node.ok) throw new Error(node.error.message);
  await setAndGet(node.value.resp.port, 'k', planted);
  await node.value.close();
  expect(await rawBytes(dataDir)).toContain(planted);
  expect((await boot(dataDir, randomBytes(32).toString('base64'))).ok).toBe(false);
});
