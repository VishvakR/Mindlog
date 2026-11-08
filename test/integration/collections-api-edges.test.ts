import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';
let admin = '';
let apiKey = '';

const call = async (
  method: string,
  path: string,
  opts: { auth?: string; body?: unknown; tenant?: string } = {},
) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.auth ? { authorization: opts.auth } : {}),
      ...(opts.tenant ? { 'x-mindlog-tenant': opts.tenant } : {}),
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

beforeAll(async () => {
  node = await startTestNode({
    limits: { authBurst: 1000 },
    mail: {
      mode: 'smtp',
      host: '127.0.0.1',
      port: 1,
      username: 'u',
      password: 'p',
      requireTls: false,
    },
    auth: {
      oauth2: [
        { name: 'google', clientId: 'g', clientSecret: 's' },
        { name: 'github', clientId: 'h', clientSecret: 's' },
        { name: 'corp', clientId: 'c', clientSecret: 's', issuer: 'http://127.0.0.1:1/' },
      ],
    },
  });
  base = `http://127.0.0.1:${String(node.node.http.port)}`;
  await node.node.admin.upsertSuperuser({ email: 'admin@x.io', password: 'correct horse battery' });
  admin = `Bearer ${String((await call('POST', '/api/superusers/auth-with-password', { body: { email: 'admin@x.io', password: 'correct horse battery' } })).json['token'])}`;
  const key = await node.node.apiKeys.create({ tenant: 'default', name: 'a' });
  if (!key.ok) throw new Error(key.error.message);
  apiKey = key.value.key;
  await call('POST', '/api/collections', {
    auth: admin,
    body: {
      name: 'users',
      type: 'auth',
      createRule: '',
      listRule: '',
      viewRule: '',
      auth: {
        otp: { enabled: true },
        oauth2: { enabled: true, providers: ['google', 'github', 'corp'] },
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await node.stop();
});

describe('credentials and tenants', () => {
  test.each([
    ['GET', '/api/collections'],
    ['GET', '/api/collections/users'],
    ['DELETE', '/api/collections/users'],
    ['GET', '/api/collections/users/records'],
    ['GET', '/api/collections/users/records/r'],
    ['DELETE', '/api/collections/users/records/r'],
    ['GET', '/api/files/users/r/f.png'],
  ])('%s %s refuses a bad token', async (method, path) => {
    expect((await call(method, path, { auth: 'Bearer not-a-token' })).status).toBe(401);
    expect((await call(method, path, { auth: 'Bearer a.b.c' })).status).toBe(401);
  });

  test('write routes refuse a bad token too', async () => {
    const auth = 'Bearer a.b.c';
    for (const [method, path, body] of [
      ['POST', '/api/collections', {}],
      ['POST', '/api/collections/rules/check', { collection: 'c', rule: '' }],
      ['PATCH', '/api/collections/users', { schema: { name: 'users' }, version: '1' }],
      ['POST', '/api/collections/users/records', {}],
      ['PATCH', '/api/collections/users/records/r', {}],
      ['POST', '/api/realtime', { clientId: 'x', subscriptions: [] }],
      ['POST', '/api/files/token', undefined],
    ] as const) {
      expect((await call(method, path, { auth, ...(body ? { body } : {}) })).status).toBe(401);
    }
  });

  test('a bare Authorization header, API keys and reserved tenants', async () => {
    expect((await call('GET', '/api/collections', { auth: admin.slice(7) })).status).toBe(200);
    expect(
      (await call('GET', '/api/collections/users/records', { auth: `Bearer ${apiKey}` })).status,
    ).toBe(200);
    expect((await call('GET', '/api/collections', { auth: 'Bearer mlk_wrong' })).status).toBe(401);
    expect((await call('GET', '/api/collections', { auth: admin, tenant: '$system' })).status).toBe(
      400,
    );
    expect(
      (await call('GET', '/api/collections', { auth: admin, tenant: 'empty' })).json['items'],
    ).toEqual([]);
  });

  test('schema updates keep the name; bad requests name their fields', async () => {
    const current = await call('GET', '/api/collections/users', { auth: admin });
    const renamed = await call('PATCH', '/api/collections/users', {
      auth: admin,
      body: { schema: { name: 'other' }, version: current.json['version'] },
    });
    expect(renamed.json['detail']).toBe('a collection keeps its name');
    const stale = await call('PATCH', '/api/collections/users', {
      auth: admin,
      body: { schema: { name: 'users', type: 'auth' }, version: '1' },
    });
    expect(stale.status).toBe(409);
    expect((await call('GET', '/api/collections/users/records?perPage=0')).status).toBe(400);
    expect((await call('GET', '/api/files/users/r/f.png?thumb=' + 'x'.repeat(40))).status).toBe(
      400,
    );
    expect(
      (
        await call(
          'GET',
          '/api/collections/users/records?skipTotal=1&sort=-created&expand=x&fields=id',
        )
      ).status,
    ).toBe(200);
    expect((await call('GET', '/api/collections/users/records/nope?expand=x')).status).toBe(404);
  });

  test('rule checks work over HTTP with a draft and a cursor', async () => {
    const checked = await call('POST', '/api/collections/rules/check', {
      auth: admin,
      body: {
        collection: 'd',
        rule: 'ti',
        cursor: 2,
        draft: { name: 'd', fields: [{ name: 'title', type: 'text' }] },
      },
    });
    expect(
      (checked.json['completions'] as { items: { label: string }[] }).items.map((i) => i.label),
    ).toEqual(['title']);
  });
});

describe('opt-in sign-in methods over HTTP', () => {
  test('auth methods list reachable providers with PKCE; an unreachable issuer is left out', async () => {
    const methods = await call(
      'GET',
      `/api/collections/users/auth-methods?redirectUrl=${encodeURIComponent('http://app/cb')}`,
    );
    const providers = (methods.json['oauth2'] as { providers: { name: string; authUrl: string }[] })
      .providers;
    expect(providers.map((p) => p.name)).toEqual(['google', 'github']);
    expect(providers[0]?.authUrl).toContain('code_challenge=');
    expect(methods.json['otp']).toEqual({ enabled: true });
  });

  test('an unreachable mail server is an error, not a hang; unknown emails reveal nothing', async () => {
    await call('POST', '/api/collections/users/records', {
      body: { email: 'ann@x.io', password: 'password123', passwordConfirm: 'password123' },
    });
    expect(
      (await call('POST', '/api/collections/users/request-otp', { body: { email: 'ann@x.io' } }))
        .status,
    ).toBe(503);
    expect(
      (await call('POST', '/api/collections/users/request-otp', { body: { email: 'nobody@x.io' } }))
        .status,
    ).toBe(200);
    expect(
      (
        await call('POST', '/api/collections/users/request-password-reset', {
          body: { email: 'nobody@x.io' },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call('POST', '/api/collections/users/request-verification', {
          body: { email: 'nobody@x.io' },
        })
      ).status,
    ).toBe(204);
    expect(
      (await call('POST', '/api/collections/users/confirm-verification', { body: { token: 'x' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/collections/users/confirm-password-reset', {
          body: { token: 'x', password: 'p', passwordConfirm: 'p' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/collections/users/auth-with-otp', {
          body: { otpId: 'x', password: 'y' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/collections/users/auth-with-oauth2', {
          body: { provider: 'google', code: 'c', state: 's' },
        })
      ).status,
    ).toBe(400);
  });

  test('settings hide provider and mail secrets; sign-in is rate limited', async () => {
    const settings = await call('GET', '/api/admin/settings', { auth: admin });
    expect(JSON.stringify(settings.json)).not.toContain('"clientSecret":"s"');
    expect((settings.json['mail'] as { password: string }).password).toBe('[redacted]');
    const limited = await startTestNode({ limits: { authBurst: 1, authPerMinute: 1 } });
    const url = `http://127.0.0.1:${String(limited.node.http.port)}/api/collections/users/auth-with-password`;
    const post = () =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"identity":"a","password":"b"}',
      });
    await post();
    expect((await post()).status).toBe(429);
    await limited.stop();
  });
});
