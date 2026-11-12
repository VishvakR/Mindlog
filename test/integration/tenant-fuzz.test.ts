import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import fc from 'fast-check';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

/**
 * Phase 10 exit gate (PLAN 24): cross-tenant access fuzzing finds nothing. Two
 * tenants hold canary values in KV, memory and audit; random callers of either
 * tenant, in every role, send random operations over HTTP, RESP and MCP, aimed
 * at their own tenant or at the other one. No answer may carry the other
 * tenant's canary, and no request naming the other tenant may succeed.
 */

const TENANTS = ['alpha', 'beta'] as const;
type TenantName = (typeof TENANTS)[number];
const ROLES = ['tenant_admin', 'developer', 'agent', 'readonly'] as const;
type Role = (typeof ROLES)[number];
const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const SEED = Number(process.env.FUZZ_SEED ?? 1009);

let node: Awaited<ReturnType<typeof startTestNode>>;
let base = '';
let root = '';
const canary: Record<TenantName, string> = { alpha: '', beta: '' };
const keys = {} as Record<TenantName, Record<Role, string>>;
const memoryIds = {} as Record<TenantName, string>;
const redis = new Map<string, Redis>();
const mcp = new Map<string, Client>();

const other = (t: TenantName): TenantName => (t === 'alpha' ? 'beta' : 'alpha');

async function http(method: string, path: string, token: string, body?: unknown, tenant?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(tenant ? { 'x-mindlog-tenant': tenant } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

async function respFor(key: string): Promise<Redis> {
  let client = redis.get(key);
  if (!client) {
    client = new Redis({
      port: node.port,
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 0,
    });
    await client.connect();
    await client.auth(key);
    redis.set(key, client);
  }
  return client;
}

async function mcpFor(key: string): Promise<Client> {
  let client = mcp.get(key);
  if (!client) {
    client = new Client(
      { name: 'fuzz', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${String(node.node.mcp.port)}/mcp`),
        {
          requestInit: { headers: { authorization: `Bearer ${key}` } },
        },
      ),
    );
    mcp.set(key, client);
  }
  return client;
}

/** A request, its answer as text, and whether it named the other tenant explicitly. */
type Attempt = (
  key: string,
  me: TenantName,
) => Promise<{ text: string; status?: number; aimed: boolean }>;

const memoryOps = [
  'list',
  'recall',
  'get',
  'getMany',
  'history',
  'export',
  'jobs',
  'conflicts',
  'scopes',
  'graph',
];
const tenantPaths = ['', '/keys', '/members', '/policies', '/audit', '/usage', '/export'];

const attempt =
  (kind: number, aimOther: boolean, pick: number): Attempt =>
  async (key, me) => {
    const target = aimOther ? other(me) : me;
    const id = memoryIds[target];
    switch (kind) {
      case 0: {
        const op = memoryOps[pick % memoryOps.length] ?? 'list';
        const body = {
          tenant: target,
          scope: { user: 'u' },
          ...(op === 'recall' ? { query: 'canary secret' } : {}),
          ...(op === 'get' || op === 'history' ? { id } : {}),
          ...(op === 'getMany' ? { ids: [id] } : {}),
          ...(op === 'graph' ? { entity: 'concept:canary' } : {}),
        };
        const r = await http('POST', `/api/memory/${op}`, key, body);
        return { ...r, aimed: aimOther };
      }
      case 1: {
        // The tenant header is only honoured for superusers; a key's tenant is its own.
        const r = await http('GET', '/api/kv/keys?count=1000', key, undefined, target);
        const read = await http('GET', '/api/kv/keys/canary', key, undefined, target);
        return { text: r.text + read.text, status: Math.max(r.status, read.status), aimed: false };
      }
      case 2: {
        const r = await http(
          'GET',
          `/api/tenants/${target}${tenantPaths[pick % tenantPaths.length] ?? ''}`,
          key,
        );
        return { ...r, aimed: aimOther };
      }
      case 3: {
        const client = await respFor(key);
        const replies = await Promise.allSettled([
          client.get('canary'),
          client.keys('*'),
          client.call('MEM.SEARCH', 'u', 'canary secret'),
          client.call('MEM.GET', 'u', id),
        ]);
        return { text: JSON.stringify(replies), aimed: false };
      }
      default: {
        const client = await mcpFor(key);
        const replies = await Promise.allSettled([
          client.callTool({ name: 'recall', arguments: { query: 'canary secret', user: 'u' } }),
          client.callTool({ name: 'history', arguments: { id, user: 'u' } }),
        ]);
        return { text: JSON.stringify(replies), aimed: false };
      }
    }
  };

beforeAll(async () => {
  node = await startTestNode({ limits: { authBurst: 100_000 } });
  base = `http://127.0.0.1:${String(node.node.http.port)}`;
  await node.node.admin.upsertSuperuser({
    email: 'root@example.com',
    password: 'correct horse battery',
  });
  const login = await fetch(`${base}/api/superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'root@example.com', password: 'correct horse battery' }),
  });
  root = ((await login.json()) as { token: string }).token;
  for (const t of TENANTS) {
    canary[t] = `CANARY${t.toUpperCase()}${randomBytes(6).toString('hex')}`;
    expect((await http('POST', '/api/tenants', root, { name: t })).status).toBe(200);
    keys[t] = {} as Record<Role, string>;
    for (const role of ROLES) {
      const made = await http('POST', `/api/tenants/${t}/keys`, root, { name: role, role });
      keys[t][role] = (JSON.parse(made.text) as { key: string }).key;
    }
    const writer = await respFor(keys[t].developer);
    await writer.set('canary', canary[t]);
    const remembered = await http('POST', '/api/memory/remember', keys[t].developer, {
      scope: { user: 'u' },
      content: `the canary secret is ${canary[t]}`,
      tags: [canary[t]],
    });
    memoryIds[t] = (JSON.parse(remembered.text) as { ids: string[] }).ids[0] ?? '';
    // A refused request of this tenant lands in its audit log, with the canary in the reason's resource.
    await http('POST', '/api/memory/forget', keys[t].readonly, {
      scope: { user: canary[t] },
      ids: [memoryIds[t]],
    });
  }
}, 120_000);

afterAll(async () => {
  for (const c of redis.values()) c.disconnect();
  await Promise.all([...mcp.values()].map((c) => c.close()));
  await node.stop();
});

test('the fixtures are readable by their own tenant', async () => {
  for (const t of TENANTS) {
    const own = await http('POST', '/api/memory/get', keys[t].developer, {
      scope: { user: 'u' },
      id: memoryIds[t],
    });
    expect(own.text).toContain(canary[t]);
    expect(await (await respFor(keys[t].readonly)).get('canary')).toBe(canary[t]);
  }
});

test(
  `no caller of one tenant ever reads the other (${String(RUNS)} runs, seed ${String(SEED)})`,
  { timeout: 600_000 },
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...TENANTS),
        fc.constantFrom(...ROLES),
        fc.integer({ min: 0, max: 4 }),
        fc.boolean(),
        fc.nat(),
        async (me, role, kind, aimOther, pick) => {
          const result = await attempt(kind, aimOther, pick)(keys[me][role], me);
          expect(result.text).not.toContain(canary[other(me)]);
          if (result.aimed && result.status !== undefined)
            expect(result.status).toBeGreaterThanOrEqual(400);
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
  },
);

test('the check can fail: a superuser, who may read every tenant, does see the canary', async () => {
  for (const kind of [0, 2]) {
    const seen = await attempt(kind, true, 0)(root, 'alpha');
    if (kind === 0) expect(seen.text).toContain(canary.beta);
    else expect(seen.status).toBe(200);
  }
});
