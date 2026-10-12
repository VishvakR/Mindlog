import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CONSOLE_PROTOCOL, PROBLEM_CONTENT_TYPE } from '@mindlog/adapter-http';
import { httpNode } from './support/http-node.js';

type Reply = Awaited<ReturnType<Awaited<ReturnType<typeof httpNode>>['run']>>;
const plainOf = (reply: Reply) =>
  reply.kind.case === 'bulk' ? new TextDecoder().decode(reply.kind.value) : reply.kind.value;

describe('health and metrics', () => {
  test('health is always ok; ready follows the node', async () => {
    const node = await httpNode({ ready: false });
    expect((await node.app.inject('/health')).json()).toEqual({ status: 'ok' });
    const notReady = await node.app.inject('/ready');
    expect(notReady.statusCode).toBe(503);
    expect(notReady.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(notReady.json()).toMatchObject({ code: 'UNAVAILABLE', status: 503 });
    expect((await (await httpNode()).app.inject('/ready')).json()).toEqual({ status: 'ready' });
  });

  test('metrics expose HTTP and KV series in Prometheus text format', async () => {
    const node = await httpNode();
    await node.app.inject({ url: '/api/kv/keys', headers: node.authed });
    const metrics = await node.app.inject('/metrics');
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('mindlog_http_request_latency_seconds_bucket');
    expect(metrics.body).toContain('route="/api/kv/keys"');
    expect(metrics.body).toContain('mindlog_kv_command_latency_seconds');
  });
});

describe('authentication', () => {
  const protectedRoutes = [
    ['GET', '/api/kv/keys'],
    ['GET', '/api/kv/keys/k'],
    ['PUT', '/api/kv/keys/k'],
    ['DELETE', '/api/kv/keys/k'],
    ['PUT', '/api/kv/keys/k/ttl'],
    ['GET', '/api/admin/overview'],
    ['GET', '/api/admin/settings'],
    ['GET', '/api/superusers/me'],
    ['GET', '/api/console'],
  ] as const;

  test.each(protectedRoutes)('%s %s needs a valid bearer token', async (method, url) => {
    const node = await httpNode();
    for (const headers of [
      {},
      { authorization: 'Bearer nope' },
      { authorization: `Bearer ${node.token}x` },
    ]) {
      const res = await node.app.inject({ method, url, headers, payload: {} });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        code: 'UNAUTHENTICATED',
        type: 'urn:mindlog:error:unauthenticated',
      });
    }
  });

  test('login rejects a wrong password with problem details', async () => {
    const node = await httpNode();
    const res = await node.app.inject({
      method: 'POST',
      url: '/api/superusers/auth-with-password',
      payload: { email: 'admin@example.com', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'INVALID_CREDENTIALS', retryable: false });
  });

  test('me returns the logged-in superuser; exists is public', async () => {
    const node = await httpNode();
    expect(
      (await node.app.inject({ url: '/api/superusers/me', headers: node.authed })).json(),
    ).toMatchObject({
      email: 'admin@example.com',
    });
    expect((await node.app.inject('/api/superusers/exists')).json()).toEqual({ exists: true });
  });
});

describe('KV API', () => {
  test('a key written over HTTP is visible to RESP, and the reverse', async () => {
    const node = await httpNode();
    const put = await node.app.inject({
      method: 'PUT',
      url: '/api/kv/keys/user%3A1',
      headers: node.authed,
      payload: { type: 'hash', value: [{ field: 'name', value: 'Ada' }], ttlMs: 60_000 },
    });
    expect(put.statusCode).toBe(204);
    expect(plainOf(await node.run('HGET', 'user:1', 'name'))).toBe('Ada');

    await node.run('ZADD', 'board', '2', 'b', '1', 'a');
    const get = await node.app.inject({ url: '/api/kv/keys/board', headers: node.authed });
    expect(get.json()).toMatchObject({
      key: 'board',
      type: 'zset',
      value: [
        { member: 'a', score: 1 },
        { member: 'b', score: 2 },
      ],
      ttlMs: null,
    });
  });

  test('keys containing slashes work when URL-encoded', async () => {
    const node = await httpNode();
    await node.run('SET', 'a/b', 'v');
    const get = await node.app.inject({
      url: `/api/kv/keys/${encodeURIComponent('a/b')}`,
      headers: node.authed,
    });
    expect(get.json()).toMatchObject({ key: 'a/b', type: 'string', value: 'v' });
  });

  test('scan, ttl and delete', async () => {
    const node = await httpNode();
    await node.run('SET', 'k1', 'v');
    await node.run('LPUSH', 'k2', 'x');
    const scan = await node.app.inject({
      url: '/api/kv/keys?count=100&type=list',
      headers: node.authed,
    });
    expect(scan.json()).toEqual({
      cursor: '0',
      keys: [{ key: 'k2', encoding: 'utf8', type: 'list', ttlMs: null }],
    });
    const ttl = await node.app.inject({
      method: 'PUT',
      url: '/api/kv/keys/k1/ttl',
      headers: node.authed,
      payload: { ttlMs: 5000 },
    });
    expect(ttl.statusCode).toBe(204);
    expect(plainOf(await node.run('PTTL', 'k1'))).toBe(5000n);
    expect(
      (await node.app.inject({ method: 'DELETE', url: '/api/kv/keys/k1', headers: node.authed }))
        .statusCode,
    ).toBe(204);
    const gone = await node.app.inject({ url: '/api/kv/keys/k1', headers: node.authed });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({
      code: 'NOT_FOUND',
      title: expect.stringMatching(/./) as unknown,
    });
  });

  test('invalid bodies and queries are 400 with field errors', async () => {
    const node = await httpNode();
    const bad = await node.app.inject({
      method: 'PUT',
      url: '/api/kv/keys/k',
      headers: node.authed,
      payload: { type: 'set', value: [] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      code: 'INVALID_ARGUMENT',
      fields: { value: expect.stringMatching(/./) as unknown },
    });
    const badQuery = await node.app.inject({ url: '/api/kv/keys?count=0', headers: node.authed });
    expect(badQuery.json()).toMatchObject({
      code: 'INVALID_ARGUMENT',
      fields: { count: expect.stringMatching(/./) as unknown },
    });
  });

  test('a negative TTL is a validation error', async () => {
    const node = await httpNode();
    await node.run('SET', 'k', 'v');
    const res = await node.app.inject({
      method: 'PUT',
      url: '/api/kv/keys/k/ttl',
      headers: node.authed,
      payload: { ttlMs: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  test('unknown API routes and oversized bodies are problems too', async () => {
    const node = await httpNode();
    const missing = await node.app.inject({ url: '/api/nope', headers: node.authed });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    const big = await node.app.inject({
      method: 'PUT',
      url: '/api/kv/keys/k',
      headers: { ...node.authed, 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'string', value: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('admin and OpenAPI', () => {
  test('overview and settings come from the composition root', async () => {
    const node = await httpNode();
    expect(
      (await node.app.inject({ url: '/api/admin/overview', headers: node.authed })).json(),
    ).toEqual({
      version: '0.0.0-test',
      keys: 0,
    });
    expect(
      (await node.app.inject({ url: '/api/admin/settings', headers: node.authed })).json(),
    ).toEqual({
      auth: { password: '[redacted]' },
    });
  });

  test('the OpenAPI document lists every JSON route with its schemas', async () => {
    const node = await httpNode();
    const doc = (await node.app.inject('/api/openapi.json')).json<{
      openapi: string;
      paths: Record<string, Record<string, { security?: unknown; requestBody?: unknown }>>;
    }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/admin/overview',
      '/api/admin/settings',
      '/api/kv/keys',
      '/api/kv/keys/{key}',
      '/api/kv/keys/{key}/ttl',
      '/api/superusers/auth-with-password',
      '/api/superusers/exists',
      '/api/superusers/me',
      '/health',
      '/ready',
    ]);
    expect(Object.keys(doc.paths['/api/kv/keys/{key}'] ?? {}).sort()).toEqual([
      'delete',
      'get',
      'put',
    ]);
    expect(doc.paths['/api/kv/keys/{key}']?.put?.requestBody).toBeDefined();
    expect(doc.paths['/health']?.get?.security).toBeUndefined();
  });
});

describe('dashboard', () => {
  test('without a build, /_/ explains how to build it', async () => {
    const node = await httpNode();
    const res = await node.app.inject('/_/');
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Dashboard not built');
  });

  test('serves assets, falls back to index.html for client routes, and sets CSP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mindlog-dash-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Mindlog</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const node = await httpNode({ dashboardDir: dir });
    expect((await node.app.inject('/_')).statusCode).toBe(302);
    const index = await node.app.inject('/_/');
    expect(index.body).toContain('<title>Mindlog</title>');
    expect(index.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await node.app.inject('/_/app.js')).body).toBe('console.log(1)');
    expect((await node.app.inject('/_/data/keys')).body).toContain('<title>Mindlog</title>');
    expect((await node.app.inject('/_/missing.js')).statusCode).toBe(404);
  });
});

describe('console', () => {
  const frame = (...args: string[]) =>
    Buffer.from(
      `*${String(args.length)}\r\n${args.map((a) => `$${String(Buffer.byteLength(a))}\r\n${a}\r\n`).join('')}`,
    );

  test('proxies RESP over a WebSocket, preauthenticated as the superuser', async () => {
    const node = await httpNode();
    const listening = await node.http.listen();
    if (!listening.ok) throw new Error(listening.error.message);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${String(listening.value.port)}/api/console`, [
        CONSOLE_PROTOCOL,
        `bearer.${node.token}`,
      ]);
      ws.binaryType = 'arraybuffer';
      let received = '';
      const got = (text: string) =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (received.length >= text.length) resolve();
            else setTimeout(check, 5);
          };
          check();
        });
      ws.onmessage = (e) => (received += Buffer.from(e.data as ArrayBuffer).toString());
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      expect(ws.protocol).toBe(CONSOLE_PROTOCOL);
      ws.send(Buffer.concat([frame('SET', 'c', '1'), frame('INCR', 'c')]));
      await got('+OK\r\n:2\r\n');
      expect(received).toBe('+OK\r\n:2\r\n');
      ws.close();
    } finally {
      await node.http.close();
    }
  });

  test('refuses the upgrade without a token', async () => {
    const node = await httpNode();
    const listening = await node.http.listen();
    if (!listening.ok) throw new Error(listening.error.message);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${String(listening.value.port)}/api/console`, [
        CONSOLE_PROTOCOL,
      ]);
      const outcome = await new Promise<string>((resolve) => {
        ws.onopen = () => {
          resolve('open');
        };
        ws.onerror = ws.onclose = () => {
          resolve('refused');
        };
      });
      expect(outcome).toBe('refused');
    } finally {
      await node.http.close();
    }
  });
});
