import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

/** PLAN 24 phase 10: PII redaction, tenant export, and tenant deletion on an encrypted node. */

let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';
let root = '';

async function call(
  method: string,
  path: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  const json =
    type.includes('json') && bytes.length > 0
      ? (JSON.parse(bytes.toString()) as Record<string, unknown>)
      : {};
  return { status: res.status, body: json, bytes };
}

async function until(check: () => Promise<boolean>, what: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function keyOf(tenant: string, role = 'developer') {
  const made = await call('POST', `/api/tenants/${tenant}/keys`, root, { name: role, role });
  expect(made.status).toBe(200);
  return String(made.body.key);
}

async function resp(key: string) {
  const client = new Redis({ port: node.port, lazyConnect: true, enableReadyCheck: false });
  await client.connect();
  await client.auth(key);
  return client;
}

beforeAll(async () => {
  node = await startTestNode({
    limits: { authBurst: 10_000 },
    storage: { encryption: { masterKey: randomBytes(32).toString('base64') } },
    tenancy: { deleteGraceMs: 0 },
  });
  base = `http://127.0.0.1:${String(node.node.http.port)}`;
  const saved = await node.node.admin.upsertSuperuser({
    email: 'root@example.com',
    password: 'correct horse battery',
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const login = await call('POST', '/api/superusers/auth-with-password', undefined, {
    email: 'root@example.com',
    password: 'correct horse battery',
  });
  root = String(login.body.token);
});

afterAll(async () => {
  await node.stop();
});

describe('PII redaction', () => {
  test('a tenant with a policy stores masked text, tags and metadata', async () => {
    await call('POST', '/api/tenants', root, { name: 'private', redaction: { enabled: true } });
    const key = await keyOf('private');
    const remembered = await call('POST', '/api/memory/remember', key, {
      scope: { user: 'ann' },
      content: 'Reach Ann at ann@example.com or +1 (415) 555-0132.',
      tags: ['owner:ann@example.com'],
      meta: { card: '4111 1111 1111 1111' },
    });
    expect(remembered.status).toBe(200);
    const listed = await call('POST', '/api/memory/list', key, { scope: { user: 'ann' } });
    const text = JSON.stringify(listed.body);
    expect(text).toContain('[EMAIL]');
    expect(text).toContain('[PHONE]');
    expect(text).not.toContain('ann@example.com');
    expect(text).not.toContain('555-0132');
  });

  test('a tenant without one stores the text as given', async () => {
    await call('POST', '/api/tenants', root, { name: 'plain' });
    const key = await keyOf('plain');
    await call('POST', '/api/memory/remember', key, {
      scope: { user: 'bo' },
      content: 'Bo is bo@example.com',
    });
    const listed = await call('POST', '/api/memory/list', key, { scope: { user: 'bo' } });
    expect(JSON.stringify(listed.body)).toContain('bo@example.com');
  });
});

describe('tenant export', () => {
  test('an admin exports KV and memory as one archive; others may not', async () => {
    await call('POST', '/api/tenants', root, { name: 'exp' });
    const admin = await keyOf('exp', 'tenant_admin');
    const dev = await keyOf('exp');
    const client = await resp(dev);
    await client.set('greeting', 'hello');
    client.disconnect();
    await call('POST', '/api/memory/remember', dev, {
      scope: { user: 'u' },
      content: 'Tea, not coffee.',
    });
    expect((await call('POST', '/api/tenants/exp/export', dev)).status).toBe(403);
    expect((await call('POST', '/api/tenants/exp/export', admin)).status).toBe(200);
    await until(
      async () => (await call('GET', '/api/tenants/exp/export', admin)).body.status === 'done',
      'the export',
    );
    const archive = await call('GET', '/api/tenants/exp/export/archive', admin);
    expect(archive.status).toBe(200);
    const lines = gunzipSync(archive.bytes)
      .toString()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; key?: { key: string } });
    expect(lines[0]?.type).toBe('tenant');
    expect(lines.some((l) => l.type === 'kv' && l.key?.key === 'greeting')).toBe(true);
    expect(lines.some((l) => l.type === 'memory')).toBe(true);
    expect((await call('GET', '/api/tenants/exp/export/archive', dev)).status).toBe(403);
  });
});

describe('tenant deletion', () => {
  test(
    'refuses the tenant at once, purges it, and leaves the others intact',
    { timeout: 60_000 },
    async () => {
      await call('POST', '/api/tenants', root, { name: 'gone' });
      await call('POST', '/api/tenants', root, { name: 'kept' });
      const goneKey = await keyOf('gone');
      const keptKey = await keyOf('kept');
      for (const key of [goneKey, keptKey]) {
        const client = await resp(key);
        for (let i = 0; i < 50; i++) await client.set(`k${String(i)}`, 'v');
        client.disconnect();
        await call('POST', '/api/memory/remember', key, {
          scope: { user: 'u' },
          content: 'A fact.',
        });
      }
      expect((await call('DELETE', '/api/tenants/gone', keptKey)).status).toBe(403);
      expect((await call('DELETE', '/api/tenants/gone', root)).status).toBe(200);
      expect((await call('GET', '/api/kv/keys', goneKey)).status).toBe(403);
      await until(async () => {
        const t = await call('GET', '/api/tenants/gone', root);
        return t.body.status === 'deleted';
      }, 'the purge');
      const goneKeys = await call('GET', '/api/kv/keys?count=1000', root, undefined, {
        'x-mindlog-tenant': 'gone',
      });
      expect(goneKeys.body.keys).toEqual([]);
      const keptKeys = await call('GET', '/api/kv/keys?count=1000', keptKey);
      expect((keptKeys.body.keys as unknown[]).length).toBe(50);
      const memory = await call('POST', '/api/memory/list', keptKey, { scope: { user: 'u' } });
      expect(JSON.stringify(memory.body)).toContain('A fact.');
      expect((await call('POST', '/api/tenants', root, { name: 'gone' })).status).toBe(409);
    },
  );
});
