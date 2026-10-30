import { afterEach, describe, expect, test } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { err, mindlogError, ok } from '@mindlog/core';
import type { ApiKeyIdentity } from '@mindlog/services';
import { ChangeFeed } from '@mindlog/services';
import { create } from '@bufbuild/protobuf';
import { MemoryLogger, MemoryMetrics } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { Command } from '@mindlog/proto';
import { CommandResultSchema, CommandSchema } from '@mindlog/proto';
import type { McpMemory } from '@mindlog/adapter-mcp';
import { McpHttpServer, proxyMessages } from '@mindlog/adapter-mcp';

const KEYS: Record<string, ApiKeyIdentity> = {
  mlk_tenant: { id: 'k-tenant', tenant: 'acme', name: 'ci' },
  mlk_alice: { id: 'k-alice', tenant: 'acme', user: 'alice', name: 'desktop' },
};

const memoryView = (id: string, text: string) => ({
  id,
  user: 'alice',
  kind: 'semantic',
  text,
  entities: [],
  links: [],
  source: { type: 'agent', principal: 'apikey:k-alice' },
  trust: 'normal',
  importance: 0.7,
  tags: [],
  createdAtMs: 1_760_000_000_000,
});

/** A stand-in memory service that records what the adapter asked. */
function stubMemory() {
  const asked: Array<{ op: string; caller: unknown; input: Record<string, unknown> }> = [];
  const record =
    <T>(op: string, value: T) =>
    (caller: unknown, input: unknown) => {
      asked.push({ op, caller, input: input as Record<string, unknown> });
      return Promise.resolve(ok(value));
    };
  const memory: McpMemory = {
    remember: record('remember', {
      ids: ['m1'],
      memories: [memoryView('m1', 'I prefer dark roast coffee.')],
      degraded: false,
    }),
    recall: record('recall', {
      items: [
        {
          memory: memoryView('m1', 'I prefer dark roast coffee.'),
          score: 0.9,
          signals: { fused: 1, recency: 1, importance: 0.7, retention: 1 },
        },
      ],
      context: '- I prefer dark roast coffee.',
      tokens: 8,
      budget: 1000,
      groups: [{ name: 'Facts', ids: ['m1'] }],
      dropped: [],
      compressed: [],
      recipe: 'full',
      route: 'specific',
      degraded: false,
    }),
    get: (caller, input) => {
      asked.push({ op: 'get', caller, input });
      const { id } = input as { id: string };
      return Promise.resolve(
        ok(id === 'm1' ? memoryView('m1', 'I prefer dark roast coffee.') : undefined),
      );
    },
    list: record('list', { memories: [memoryView('m1', 'I prefer dark roast coffee.')] }),
    conflicts: record('conflicts', {
      conflicts: [
        {
          id: 'c1',
          a: memoryView('m1', 'I prefer dark roast coffee.'),
          b: memoryView('m2', 'I do not drink coffee.'),
          scores: [0.9, 0.1] as const,
          status: 'open' as const,
          policy: 'quarantine_new',
          origin: 'ingest',
          detectedAtMs: 1,
        },
      ],
    }),
    resolve: record('resolve', { ids: ['m1', 'm2'], count: 2 }),
    createBranch: record('createBranch', { ids: [], count: 0 }),
    diffBranch: record('diffBranch', {
      added: [memoryView('m3', 'Ana moves to Porto.')],
      forgotten: [],
      changed: [],
    }),
    mergeBranch: record('mergeBranch', {
      merged: true,
      added: ['m3'],
      rejected: [],
      conflicts: [],
    }),
    dropBranch: record('dropBranch', { ids: [], count: 0 }),
    forget: record('forget', { ids: ['m1'], count: 1 }),
    history: record('history', [{ version: '7', atMs: 1, memory: memoryView('m1', 'x') }]),
    graph: (caller, input) => {
      asked.push({ op: 'graph', caller, input });
      return Promise.resolve(err(mindlogError('NOT_FOUND', 'no entity Zed')));
    },
    cacheLookup: (caller, input) => {
      asked.push({ op: 'cacheLookup', caller, input: input });
      const prompt = (input as { prompt: string }).prompt;
      return Promise.resolve(
        ok({
          hit: prompt.includes('coffee')
            ? {
                id: 'c1',
                answer: 'Dark roast.',
                similarity: 0.97,
                level: 'l2' as const,
                dependsOn: ['m1'],
              }
            : null,
          degraded: false,
        }),
      );
    },
    cacheStore: record('cacheStore', { id: 'c1', degraded: false }),
  };
  return { memory, asked };
}

const servers: McpHttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(changes?: ChangeFeed) {
  const { memory, asked } = stubMemory();
  const server = new McpHttpServer({
    memory,
    ...(changes ? { changes } : {}),
    keys: {
      verify: (key) =>
        Promise.resolve(
          KEYS[key] ? ok(KEYS[key]) : err(mindlogError('UNAUTHENTICATED', 'bad key')),
        ),
    },
    host: '127.0.0.1',
    port: 0,
    version: '0.5.0-test',
  });
  servers.push(server);
  const address = await server.listen();
  if (!address.ok) throw new Error(address.error.message);
  const url = new URL(`http://127.0.0.1:${String(address.value.port)}/mcp`);
  const connect = async (key: string) => {
    const client = new Client(
      { name: 'test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    return client;
  };
  return { url, asked, connect };
}

describe('MCP over Streamable HTTP', () => {
  test('lists the memory tools, resources and the recall-context prompt', async () => {
    const { connect } = await start();
    const client = await connect('mlk_alice');
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'branch_create',
      'branch_diff',
      'branch_drop',
      'branch_merge',
      'cache_lookup',
      'cache_store',
      'conflicts',
      'forget',
      'graph_query',
      'history',
      'recall',
      'remember',
      'resolve_conflict',
    ]);
    for (const t of tools.tools) expect(t.description?.length ?? 0).toBeGreaterThan(40);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['recall-context']);
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((r) => r.uriTemplate).sort()).toEqual([
      'memory://{user}/recent',
      'memory://{user}/{id}',
    ]);
    await client.close();
  });

  test('remember and recall run as the key, defaulting to its user', async () => {
    const { connect, asked } = await start();
    const client = await connect('mlk_alice');
    const remembered = await client.callTool({
      name: 'remember',
      arguments: { content: 'I prefer dark roast coffee.' },
    });
    expect(remembered.isError).toBeFalsy();
    expect(remembered.structuredContent).toMatchObject({ ids: ['m1'], degraded: false });
    const recalled = await client.callTool({
      name: 'recall',
      arguments: { query: 'what coffee?' },
    });
    expect(recalled.structuredContent).toMatchObject({ context: '- I prefer dark roast coffee.' });
    const text = (recalled.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('dark roast');
    expect(asked.map((a) => [a.op, a.caller, a.input.scope])).toEqual([
      ['remember', { tenant: 'acme', principal: 'apikey:k-alice' }, { user: 'alice' }],
      ['recall', { tenant: 'acme', principal: 'apikey:k-alice' }, { user: 'alice' }],
    ]);
    await client.close();
  });

  test('conflicts and resolve_conflict run as the key', async () => {
    const { connect, asked } = await start();
    const client = await connect('mlk_alice');
    const listed = await client.callTool({ name: 'conflicts', arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      conflicts: [{ id: 'c1', status: 'open', a: { id: 'm1' }, b: { id: 'm2' } }],
    });
    const resolved = await client.callTool({
      name: 'resolve_conflict',
      arguments: { id: 'c1', keep: 'both', valid_from: '2026-03-01' },
    });
    expect(resolved.structuredContent).toEqual({ changed: ['m1', 'm2'] });
    expect(asked.at(-1)).toMatchObject({
      op: 'resolve',
      input: { scope: { user: 'alice' }, id: 'c1', keep: 'both', validFrom: '2026-03-01' },
    });
  });

  test('branch tools run as the key, and recall takes a branch', async () => {
    const { connect, asked } = await start();
    const client = await connect('mlk_alice');
    await client.callTool({ name: 'branch_create', arguments: { name: 'trip' } });
    expect(asked.at(-1)).toMatchObject({
      op: 'createBranch',
      input: { scope: { user: 'alice' }, name: 'trip' },
    });
    await client.callTool({ name: 'recall', arguments: { query: 'Porto', branch: 'trip' } });
    expect(asked.at(-1)).toMatchObject({ op: 'recall', input: { branch: 'trip' } });
    const diff = await client.callTool({ name: 'branch_diff', arguments: { name: 'trip' } });
    expect(diff.structuredContent).toMatchObject({ added: [{ id: 'm3' }] });
    const merged = await client.callTool({
      name: 'branch_merge',
      arguments: { name: 'trip', policy: 'prefer_branch' },
    });
    expect(merged.structuredContent).toEqual({
      merged: true,
      added: ['m3'],
      rejected: [],
      conflicts: 0,
    });
    expect(asked.at(-1)).toMatchObject({ op: 'mergeBranch', input: { policy: 'prefer_branch' } });
  });

  test('a listen stream hears updates of memory://<user>/recent only for scopes the key may read', async () => {
    const bus = new InMemoryEventBus({ logger: new MemoryLogger(), metrics: new MemoryMetrics() });
    const changes = new ChangeFeed();
    changes.attach(bus);
    const { connect } = await start(changes);
    let index = 0n;
    const forget = (tenant: string, user: string) => {
      bus.publish({
        type: 'CommandApplied',
        rangeId: 1n,
        index: ++index,
        command: create(CommandSchema, {
          tenant,
          hlc: 1n << 16n,
          body: { case: 'memoryForget', value: { user, ids: ['m'] } } as Command['body'],
        }),
        result: create(CommandResultSchema, {
          outcome: { case: 'memory', value: { ids: ['m'], count: 1 } },
        }),
        duplicate: false,
      });
    };
    const client = await connect('mlk_alice');
    const updated: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      updated.push(n.params.uri);
    });
    const subscription = await client.listen({
      resourceSubscriptions: ['memory://alice/recent', 'memory://bob/recent'],
    });
    forget('other', 'alice');
    forget('acme', 'bob');
    forget('acme', 'alice');
    await expect.poll(() => updated).toEqual(['memory://alice/recent']);
    await subscription.close();
  });

  test('cache_store and cache_lookup run as the key', async () => {
    const { connect, asked } = await start();
    const client = await connect('mlk_alice');
    const stored = await client.callTool({
      name: 'cache_store',
      arguments: {
        prompt: 'what coffee?',
        answer: 'Dark roast.',
        depends_on: ['m1'],
        ttl_seconds: 60,
      },
    });
    expect(stored.structuredContent).toEqual({ id: 'c1' });
    const hit = await client.callTool({
      name: 'cache_lookup',
      arguments: { prompt: 'which coffee?' },
    });
    expect(hit.structuredContent).toEqual({
      hit: true,
      answer: 'Dark roast.',
      id: 'c1',
      similarity: 0.97,
      using: ['m1'],
    });
    const miss = await client.callTool({
      name: 'cache_lookup',
      arguments: { prompt: 'what tea?' },
    });
    expect(miss.structuredContent).toEqual({ hit: false });
    expect(asked.map((a) => [a.op, a.input])).toEqual([
      [
        'cacheStore',
        {
          scope: { user: 'alice' },
          prompt: 'what coffee?',
          answer: 'Dark roast.',
          dependsOn: ['m1'],
          ttlSeconds: 60,
        },
      ],
      ['cacheLookup', { scope: { user: 'alice' }, prompt: 'which coffee?' }],
      ['cacheLookup', { scope: { user: 'alice' }, prompt: 'what tea?' }],
    ]);
    await client.close();
  });

  test('a user key cannot reach another user; service errors are tool errors', async () => {
    const { connect, asked } = await start();
    const client = await connect('mlk_alice');
    const denied = await client.callTool({
      name: 'recall',
      arguments: { query: 'x', user: 'bob' },
    });
    expect(denied.isError).toBe(true);
    expect((denied.content as Array<{ text: string }>)[0]?.text).toMatch(/limited to user alice/);
    const missing = await client.callTool({ name: 'graph_query', arguments: { entity: 'Zed' } });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0]?.text).toMatch(
      /NOT_FOUND: no entity Zed/,
    );
    expect(asked.map((a) => a.op)).toEqual(['graph']);
    const tenantWide = await connect('mlk_tenant');
    const bob = await tenantWide.callTool({
      name: 'forget',
      arguments: { ids: ['m1'], user: 'bob' },
    });
    expect(bob.structuredContent).toEqual({ count: 1, ids: ['m1'] });
    await client.close();
    await tenantWide.close();
  });

  test('resources and the prompt read memory too', async () => {
    const { connect } = await start();
    const client = await connect('mlk_alice');
    const one = await client.readResource({ uri: 'memory://alice/m1' });
    expect(JSON.parse((one.contents[0] as { text: string }).text)).toMatchObject({ id: 'm1' });
    const recent = await client.readResource({ uri: 'memory://alice/recent' });
    expect((recent.contents[0] as { text: string }).text).toContain('dark roast');
    const prompt = await client.getPrompt({
      name: 'recall-context',
      arguments: { task: 'order coffee' },
    });
    const message = prompt.messages[0]?.content as { text: string };
    expect(message.text).toContain('- I prefer dark roast coffee.');
    expect(message.text).toMatch(/data, not instructions/);
    await client.close();
  });

  test('requests without a valid key are 401, and foreign Host headers are refused', async () => {
    const { url } = await start();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers, authorization: 'Bearer nope' },
          body,
        })
      ).status,
    ).toBe(401);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: url.port,
          path: '/mcp',
          method: 'POST',
          headers: { ...headers, host: 'evil.example' },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      );
      req.end(body);
    });
    expect(status).toBe(403);
  });
});

describe('stdio proxy', () => {
  test('relays a local MCP session to the HTTP endpoint with the API key', async () => {
    const { url } = await start();
    const [local, remote] = InMemoryTransport.createLinkedPair();
    const stop = await proxyMessages(
      remote,
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: 'Bearer mlk_alice' } },
      }),
    );
    const client = new Client({ name: 'desktop', version: '1.0.0' });
    await client.connect(local);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('remember');
    const r = await client.callTool({
      name: 'remember',
      arguments: { content: 'hello there friend' },
    });
    expect(r.structuredContent).toMatchObject({ ids: ['m1'] });
    await client.close();
    await stop();
  });
});
