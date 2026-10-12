import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MemoryLogger, MemoryMetrics } from '@mindlog/core';
import type { MainIo, RunningNode } from '@mindlog/server';
import { main } from '@mindlog/server';

const ADMIN = { email: 'admin@example.com', password: 'a long password' };
let dir: string;
let node: RunningNode;
let redis: Redis;
let api: string;
let token: string;

const io = (): MainIo => ({
  cwd: dir,
  env: {},
  stdout: () => undefined,
  stderr: () => undefined,
  node: { logger: new MemoryLogger(), metrics: new MemoryMetrics() },
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mindlog-dashboard-'));
  const dataDir = join(dir, 'data');
  await main(['superuser', 'upsert', ADMIN.email, ADMIN.password, '--data-dir', dataDir], io());
  const started = await main(
    [
      '--single-node',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--http-port',
      '0',
      '--data-dir',
      dataDir,
    ],
    io(),
  );
  if (started.kind !== 'running') throw new Error('node did not start');
  node = started.node;
  api = `http://127.0.0.1:${String(node.http.port)}/api`;
  const login = await fetch(`${api}/superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  token = ((await login.json()) as { token: string }).token;
  redis = new Redis({ port: node.resp.port, host: '127.0.0.1' });
});

afterAll(async () => {
  redis.disconnect();
  await node.close();
  await rm(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('dashboard ↔ redis-cli (phase 2 gate)', () => {
  test('an edit over HTTP is visible to a Redis client', async () => {
    const put = await call('PUT', '/kv/keys/profile%3A42', {
      type: 'hash',
      value: [
        { field: 'name', value: 'Grace' },
        { field: 'lang', value: 'COBOL' },
      ],
      ttlMs: 600_000,
    });
    expect(put.status).toBe(204);
    expect(await redis.hgetall('profile:42')).toEqual({ name: 'Grace', lang: 'COBOL' });
    expect(await redis.pttl('profile:42')).toBeGreaterThan(590_000);
  });

  test('an edit from a Redis client is visible over HTTP', async () => {
    await redis.zadd('leaders', 30, 'carol', 10, 'alice', 20, 'bob');
    const res = await call('GET', '/kv/keys/leaders');
    expect(await res.json()).toMatchObject({
      type: 'zset',
      value: [
        { member: 'alice', score: 10 },
        { member: 'bob', score: 20 },
        { member: 'carol', score: 30 },
      ],
    });
    const scan = await call('GET', '/kv/keys?type=zset&count=1000');
    expect(await scan.json()).toMatchObject({ keys: [{ key: 'leaders', type: 'zset' }] });
  });

  test('a delete over HTTP removes the key for Redis clients', async () => {
    await redis.set('temp', '1');
    expect((await call('DELETE', '/kv/keys/temp')).status).toBe(204);
    expect(await redis.exists('temp')).toBe(0);
  });
});
