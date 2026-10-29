import { describe, expect, test } from 'vitest';
import type { MindlogConfig } from '@mindlog/core';
import { create } from '@bufbuild/protobuf';
import { MemoryLogger, MemoryMetrics, packHlc, resolveConfig } from '@mindlog/core';
import { CommandSchema } from '@mindlog/proto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { RunningNode } from '@mindlog/server';
import { startNode } from '@mindlog/server';
import { respClient } from './support/resp-client.js';
import { tempDir } from './support/temp-dir.js';

function config(dataDir: string, extra: Record<string, unknown> = {}): MindlogConfig {
  const result = resolveConfig({
    flags: {
      node: { dataDir },
      listen: {
        resp: { host: '127.0.0.1', port: 0 },
        http: { host: '127.0.0.1', port: 0 },
        mcp: { http: { port: 0 } },
      },
      ...extra,
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function start(cfg: MindlogConfig): Promise<RunningNode & { memory: MemoryLogger }> {
  const memory = new MemoryLogger();
  const node = await startNode(cfg, { logger: memory, metrics: new MemoryMetrics() });
  if (!node.ok) throw new Error(node.error.message);
  return { ...node.value, memory };
}

describe('startNode', () => {
  test('serves RESP and keeps data across a restart', async () => {
    const dir = await tempDir();
    const first = await start(config(dir));
    const client = await respClient(first.resp.port);
    expect(await client.call('SET', 'greeting', 'hello')).toBe('+OK\r\n');
    expect(await client.call('HSET', 'h', 'f', 'v')).toBe(':1\r\n');
    expect(await client.call('INFO', 'server')).toContain(`tcp_port:${String(first.resp.port)}`);
    await client.close();
    await first.close();
    expect(first.memory.entries.map((e) => e.message)).toContain('node stopped');

    const second = await start(config(dir));
    const again = await respClient(second.resp.port);
    expect(await again.call('GET', 'greeting')).toBe('$5\r\nhello\r\n');
    expect(await again.call('HGET', 'h', 'f')).toBe('$1\r\nv\r\n');
    await again.close();
    await second.close();
  });

  test('a data directory in use by another node is UNAVAILABLE', async () => {
    const dir = await tempDir();
    const first = await start(config(dir));
    const second = await startNode(config(dir), {
      logger: new MemoryLogger(),
      metrics: new MemoryMetrics(),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('UNAVAILABLE');
    const client = await respClient(first.resp.port);
    expect(await client.call('PING')).toBe('+PONG\r\n');
    await client.close();
    await first.close();
  });

  test('a busy port is an error, and the stores are released', async () => {
    const holder = await start(config(await tempDir()));
    const dir = await tempDir();
    const busy = await startNode(
      config(dir, { listen: { resp: { host: '127.0.0.1', port: holder.resp.port } } }),
      {
        logger: new MemoryLogger(),
        metrics: new MemoryMetrics(),
      },
    );
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.error.code).toBe('UNAVAILABLE');
    const reopened = await start(config(dir));
    await reopened.close();
    await holder.close();
  });

  test('a configured password is enforced', async () => {
    const node = await start(config(await tempDir(), { auth: { password: 'pw' } }));
    const client = await respClient(node.resp.port);
    expect(await client.call('GET', 'k')).toBe('-NOAUTH Authentication required.\r\n');
    expect(await client.call('AUTH', 'pw')).toBe('+OK\r\n');
    expect(await client.call('GET', 'k')).toBe('$-1\r\n');
    await client.close();
    await node.close();
  });

  test('an abandoned transaction lock is resolved when cross-range transactions are on', async () => {
    const node = await start(config(await tempDir(), { features: { crossRangeTxn: true } }));
    const b = (s: string): Uint8Array => new TextEncoder().encode(s);
    const prewrite = await node.replica.propose(
      create(CommandSchema, {
        requestId: b('abandoned-prewrite'),
        principal: 'test',
        tenant: 'default',
        hlc: packHlc(BigInt(Date.now()), 0n),
        body: {
          case: 'txnPrewrite',
          value: {
            startTs: packHlc(BigInt(Date.now()), 0n),
            primary: b('k'),
            ttlMs: 1n,
            writes: [{ argv: ['SET', 'k', 'staged'].map(b) }],
          },
        },
      }),
    );
    expect(prewrite.ok).toBe(true);
    const client = await respClient(node.resp.port);
    let reply = '';
    for (let tries = 0; tries < 40; tries++) {
      reply = await client.call('SET', 'k', 'v');
      if (reply === '+OK\r\n') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(reply).toBe('+OK\r\n');
    await client.close();
    await node.close();
  }, 20_000);

  test('close is idempotent', async () => {
    const node = await start(config(await tempDir()));
    await Promise.all([node.close(), node.close()]);
  });
});

describe('startNode MCP', () => {
  test('an agent remembers and recalls over MCP with an API key', async () => {
    const node = await start(config(await tempDir()));
    const key = await node.apiKeys.create({ tenant: 'default', user: 'alice', name: 'test agent' });
    if (!key.ok) throw new Error(key.error.message);
    const url = new URL(`http://127.0.0.1:${String(node.mcp.port)}/mcp`);
    const client = new Client(
      { name: 'agent', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${key.value.key}` } },
      }),
    );
    const remembered = await client.callTool({
      name: 'remember',
      arguments: { content: 'I prefer dark roast coffee.' },
    });
    expect(remembered.structuredContent).toMatchObject({ degraded: true });
    const recalled = await client.callTool({
      name: 'recall',
      arguments: { query: 'dark roast coffee' },
    });
    expect(recalled.structuredContent).toMatchObject({
      context: '## Recent episodes\n- I prefer dark roast coffee.',
    });
    await client.close();
    await node.close();
  }, 20_000);
});
