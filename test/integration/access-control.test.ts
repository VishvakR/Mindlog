import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

/**
 * PLAN 18.2 / phase 10: role × action × tenant over HTTP and RESP on a real
 * node, against an oracle written from the role table.
 */

type Role = 'tenant_admin' | 'developer' | 'agent' | 'readonly';
const ROLES: Role[] = ['tenant_admin', 'developer', 'agent', 'readonly'];

let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';
let root = '';
const keys: Partial<Record<Role, string>> = {};
let foreignKey = '';

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

const resp = async (key: string) => {
  const client = new Redis({ port: node.port, lazyConnect: true, enableReadyCheck: false });
  await client.connect();
  await client.auth(key);
  return client;
};

beforeAll(async () => {
  node = await startTestNode({ limits: { authBurst: 10_000 } });
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
  for (const name of ['acme', 'globex'])
    expect((await call('POST', '/api/tenants', root, { name })).status).toBe(200);
  for (const role of ROLES) {
    const made = await call('POST', '/api/tenants/acme/keys', root, { name: role, role });
    expect(made.status).toBe(200);
    keys[role] = String(made.body.key);
  }
  const foreign = await call('POST', '/api/tenants/globex/keys', root, {
    name: 'g',
    role: 'tenant_admin',
  });
  foreignKey = String(foreign.body.key);
});

afterAll(async () => {
  await node.stop();
});

const key = (role: Role) => keys[role] as string;
const expected = (allowed: boolean, status: number) => {
  expect(status === 403).toBe(!allowed);
};

describe.each(ROLES)('role %s over HTTP', (role) => {
  const canRead = true;
  const canWrite = role !== 'readonly';
  const canKv = role !== 'agent';
  const isAdmin = role === 'tenant_admin';

  test('memory read and write', async () => {
    const read = await call('POST', '/api/memory/list', key(role), { scope: { user: 'u' } });
    expected(canRead, read.status);
    const write = await call('POST', '/api/memory/forget', key(role), {
      scope: { user: 'u' },
      ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      reason: 'test',
    });
    expected(canWrite, write.status);
  });

  test('KV read and write', async () => {
    expected(canKv, (await call('GET', '/api/kv/keys', key(role))).status);
    const write = await call('PUT', '/api/kv/keys/k', key(role), {
      type: 'string',
      value: 'v',
    });
    expected(canKv && canWrite, write.status);
  });

  test('tenant administration', async () => {
    expected(isAdmin, (await call('GET', '/api/tenants/acme/keys', key(role))).status);
    expected(isAdmin, (await call('GET', '/api/tenants/acme/members', key(role))).status);
    expected(isAdmin, (await call('GET', '/api/tenants/acme/policies', key(role))).status);
  });

  test('superuser-only actions are refused', async () => {
    expect((await call('POST', '/api/tenants', key(role), { name: 'x' })).status).toBe(403);
    expect((await call('PUT', '/api/tenants/acme/quotas', key(role), {})).status).toBe(403);
    expect((await call('GET', '/api/admin/settings', key(role))).status).toBe(401);
  });

  test('never reaches another tenant', async () => {
    const other = { tenant: 'globex', scope: { user: 'u' } };
    expect((await call('POST', '/api/memory/list', key(role), other)).status).toBe(403);
    expect((await call('GET', '/api/tenants/globex/keys', key(role))).status).toBe(403);
  });
});

describe('credentials', () => {
  test('no credential is refused', async () => {
    expect((await call('GET', '/api/kv/keys', undefined)).status).toBe(401);
    expect(
      (await call('POST', '/api/memory/list', undefined, { scope: { user: 'u' } })).status,
    ).toBe(401);
  });

  test('a superuser may name any tenant, but not a reserved one', async () => {
    const list = { tenant: 'globex', scope: { user: 'u' } };
    expect((await call('POST', '/api/memory/list', root, list)).status).toBe(200);
    const reserved = await call('POST', '/api/memory/list', root, { ...list, tenant: '$system' });
    expect(reserved.status).toBeGreaterThanOrEqual(400);
  });

  test('an expired key stops working', async () => {
    const made = await call('POST', '/api/tenants/acme/keys', root, {
      name: 'old',
      role: 'developer',
      expiresAt: 1,
    });
    expect((await call('GET', '/api/kv/keys', String(made.body.key))).status).toBe(401);
  });

  test('a key pinned to a user or a scope pattern stays there', async () => {
    const pinned = await call('POST', '/api/tenants/acme/keys', root, { name: 'p', user: 'ann' });
    const scoped = await call('POST', '/api/tenants/acme/keys', root, {
      name: 's',
      scopes: ['team-*'],
    });
    const list = (token: unknown, user: string) =>
      call('POST', '/api/memory/list', String(token), { scope: { user } });
    expect((await list(pinned.body.key, 'ann')).status).toBe(200);
    expect((await list(pinned.body.key, 'bob')).status).toBe(403);
    expect((await list(scoped.body.key, 'team-1')).status).toBe(200);
    expect((await list(scoped.body.key, 'solo')).status).toBe(403);
  });

  test('a policy row grants an agent KV and a revoked key dies', async () => {
    await call('PUT', '/api/tenants/acme/policies', root, {
      policies: [{ effect: 'allow', subject: 'agent', actions: ['kv.read'] }],
    });
    await new Promise((r) => setTimeout(r, 2_100)); // the tenant cache's lifetime
    expect((await call('GET', '/api/kv/keys', key('agent'))).status).toBe(200);
    await call('PUT', '/api/tenants/acme/policies', root, { policies: [] });
    const made = await call('POST', '/api/tenants/acme/keys', root, { name: 'x' });
    expect(
      (await call('DELETE', `/api/tenants/acme/keys/${String(made.body.id)}`, root)).status,
    ).toBe(204);
    expect(
      (await call('POST', '/api/memory/list', String(made.body.key), { scope: { user: 'u' } }))
        .status,
    ).toBe(401);
  });
});

describe('dashboard accounts', () => {
  const email = 'ann@acme.test';
  const password = 'correct horse staple';

  test('a member signs in, sees only its tenant, and cannot reach operator routes', async () => {
    const put = await call('PUT', '/api/tenants/acme/members', key('tenant_admin'), {
      email,
      password,
      role: 'tenant_admin',
    });
    expect(put.status).toBe(200);
    const login = await call('POST', '/api/superusers/auth-with-password', undefined, {
      email,
      password,
    });
    const token = String(login.body.token);
    const me = await call('GET', '/api/superusers/me', token);
    expect(me.body).toMatchObject({ email, role: 'tenant_admin', tenant: 'acme' });
    expect((await call('GET', '/api/tenants/acme/keys', token)).status).toBe(200);
    expect((await call('GET', '/api/tenants/globex/keys', token)).status).toBe(403);
    expect((await call('GET', '/api/admin/settings', token)).status).toBe(403);
    expect((await call('GET', '/api/cluster', token)).status).toBeGreaterThanOrEqual(403);
  });

  test('a tenant admin cannot take over a superuser or another tenant’s account', async () => {
    const takeover = await call('PUT', '/api/tenants/acme/members', key('tenant_admin'), {
      email: 'root@example.com',
      password: 'attacker password 1',
      role: 'tenant_admin',
    });
    expect(takeover.status).toBe(403);
    const cross = await call('PUT', '/api/tenants/globex/members', foreignKey, {
      email,
      password: 'attacker password 2',
      role: 'tenant_admin',
    });
    expect(cross.status).toBe(403);
    const login = await call('POST', '/api/superusers/auth-with-password', undefined, {
      email: 'root@example.com',
      password: 'correct horse battery',
    });
    expect(login.status).toBe(200);
  });
});

describe('RESP', () => {
  test('AUTH with a key binds its tenant: keys are isolated', async () => {
    const acme = await resp(key('developer'));
    const globex = await resp(foreignKey);
    await acme.set('shared-name', 'acme-value');
    await globex.set('shared-name', 'globex-value');
    expect(await acme.get('shared-name')).toBe('acme-value');
    expect(await globex.get('shared-name')).toBe('globex-value');
    expect(await acme.keys('*')).not.toContain('globex-only');
    acme.disconnect();
    globex.disconnect();
  });

  test('roles limit commands', async () => {
    const readonly = await resp(key('readonly'));
    await expect(readonly.set('a', '1')).rejects.toThrow(/PERMISSION_DENIED|NOPERM/i);
    expect(await readonly.get('a')).toBeNull();
    readonly.disconnect();
    const agent = await resp(key('agent'));
    await expect(agent.get('a')).rejects.toThrow(/PERMISSION_DENIED|NOPERM/i);
    agent.disconnect();
  });

  test('a key-bound session cannot run cluster or config commands', async () => {
    const admin = await resp(key('tenant_admin'));
    await expect(admin.call('CLUSTER.INFO')).rejects.toThrow(/PERMISSION_DENIED|NOPERM/i);
    await expect(admin.call('CONFIG', 'GET', '*')).rejects.toThrow(/PERMISSION_DENIED|NOPERM/i);
    admin.disconnect();
  });

  test('MEM commands obey the same role', async () => {
    const readonly = await resp(key('readonly'));
    await expect(readonly.call('MEM.FORGET', 'u', '01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toThrow(
      /PERMISSION_DENIED|NOPERM/i,
    );
    readonly.disconnect();
  });

  test('a bad key is refused', async () => {
    const client = new Redis({ port: node.port, lazyConnect: true, enableReadyCheck: false });
    await client.connect();
    await expect(client.auth('mlk_nope')).rejects.toThrow();
    client.disconnect();
  });
});
