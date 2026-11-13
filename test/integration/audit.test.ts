import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

/** PLAN 18.5 / ADR-0037: the audit trail, on a node whose data spans several ranges. */

let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';
let root = '';

async function call(method: string, path: string, token: string | undefined, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

interface Entry {
  action: string;
  principal: string;
  resource: string;
  ok: boolean;
  detail: string;
}

const audit = async (tenant: string, token = root) => {
  const page = await call('GET', `/api/tenants/${tenant}/audit?limit=500`, token);
  return (page.body.items ?? []) as Entry[];
};

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  node = await startTestNode({
    limits: { authBurst: 10_000 },
    ranges: { maxBytes: 3000 },
    pd: { storeHeartbeatMs: 50, rangeHeartbeatMs: 50, schedulerIntervalMs: 50 },
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
  for (const name of ['a', 'b']) await call('POST', '/api/tenants', root, { name });
});

afterAll(async () => {
  await node.stop();
});

describe('the audit log', () => {
  test('admin changes are recorded, with who did them', async () => {
    await call('PUT', '/api/tenants/a/quotas', root, { writeQps: 1000 });
    await until(
      async () => (await audit('a')).some((e) => e.action.includes('/quotas')),
      'the quota change',
    );
    const entry = (await audit('a')).find((e) => e.action.includes('/quotas'));
    expect(entry).toMatchObject({ ok: true, principal: 'superuser:root@example.com' });
    expect((await call('PUT', '/api/tenants/a/quotas', root, { writeQps: -1 })).status).toBe(400);
    await until(async () => (await audit('a')).some((e) => !e.ok), 'the failed change');
    const failed = (await audit('a')).find((e) => !e.ok);
    expect(failed).toMatchObject({ action: 'PUT /api/tenants/:tenant/quotas', detail: 'HTTP 400' });
  });

  test('a refused request is recorded with the reason', async () => {
    const made = await call('POST', '/api/tenants/a/keys', root, { name: 'r', role: 'readonly' });
    const denied = await call('POST', '/api/memory/forget', String(made.body.key), {
      scope: { user: 'u' },
      ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      reason: 'x',
    });
    expect(denied.status).toBe(403);
    await until(
      async () => (await audit('a')).some((e) => e.action === 'memory.write' && !e.ok),
      'the refusal',
    );
  });

  test(
    'a forget command is audited through the outbox, across a split',
    { timeout: 30_000 },
    async () => {
      const made = await call('POST', '/api/tenants/b/keys', root, {
        name: 'dev',
        role: 'developer',
      });
      const key = String(made.body.key);
      const client = new Redis({ port: node.port, lazyConnect: true, enableReadyCheck: false });
      await client.connect();
      await client.auth(key);
      for (let i = 0; i < 400; i++) await client.set(`padding-${String(i)}`, 'x'.repeat(40));
      await until(async () => {
        const cluster = await call('GET', '/api/cluster/overview', root);
        return ((cluster.body.ranges ?? []) as unknown[]).length > 1;
      }, 'a split');
      const forgot = await call('POST', '/api/memory/forget', key, {
        scope: { user: 'someone' },
        ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        reason: 'audit test',
      });
      expect(forgot.status).toBe(200);
      await until(
        async () => (await audit('b')).some((e) => e.action === 'memoryForget'),
        'the forget in the audit log',
      );
      client.disconnect();
    },
  );

  test('only that tenant’s admin can read it', async () => {
    const made = await call('POST', '/api/tenants/a/keys', root, {
      name: 'adm',
      role: 'tenant_admin',
    });
    const agent = await call('POST', '/api/tenants/a/keys', root, { name: 'ag' });
    expect((await call('GET', '/api/tenants/a/audit', String(made.body.key))).status).toBe(200);
    expect((await call('GET', '/api/tenants/b/audit', String(made.body.key))).status).toBe(403);
    expect((await call('GET', '/api/tenants/a/audit', String(agent.body.key))).status).toBe(403);
  });
});
