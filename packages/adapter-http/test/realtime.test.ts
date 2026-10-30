import { create } from '@bufbuild/protobuf';
import { MemoryLogger, MemoryMetrics } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { Command } from '@mindlog/proto';
import { CommandResultSchema, CommandSchema } from '@mindlog/proto';
import { ChangeFeed } from '@mindlog/services';
import { describe, expect, test } from 'vitest';
import { httpNode } from './support/http-node.js';

describe('GET /api/realtime (PLAN 13.5)', () => {
  test('streams a scope’s changes as SSE with cursor ids, resumable with Last-Event-ID', async () => {
    const bus = new InMemoryEventBus({ logger: new MemoryLogger(), metrics: new MemoryMetrics() });
    const changes = new ChangeFeed();
    changes.attach(bus);
    let index = 0n;
    const forget = (user: string, id: string) => {
      bus.publish({
        type: 'CommandApplied',
        rangeId: 1n,
        index: ++index,
        command: create(CommandSchema, {
          tenant: 'default',
          hlc: 1n << 16n,
          body: { case: 'memoryForget', value: { user, ids: [id] } } as Command['body'],
        }),
        result: create(CommandResultSchema, {
          outcome: { case: 'memory', value: { ids: [id], count: 1 } },
        }),
        duplicate: false,
      });
    };
    const node = await httpNode({ changes });
    const bound = await node.http.listen();
    if (!bound.ok) throw new Error(bound.error.message);
    const url = `http://127.0.0.1:${String(bound.value.port)}/api/realtime?user=alice`;
    try {
      expect((await fetch(url)).status).toBe(401);
      forget('alice', 'm1');
      const abort = new AbortController();
      const res = await fetch(url, {
        headers: { ...node.authed, 'last-event-id': '1:0' },
        signal: abort.signal,
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let text = '';
      const until = async (part: string) => {
        while (!text.includes(part)) {
          const { value } = await reader.read();
          text += new TextDecoder().decode(value);
        }
      };
      await until('m1');
      forget('bob', 'b1');
      forget('alice', 'm2');
      await until('m2');
      abort.abort();
      expect(text).toContain('id: 1:1\nevent: memory.forgotten\n');
      expect(text).toContain('id: 1:3\nevent: memory.forgotten\n');
      expect(text).not.toContain('b1');
    } finally {
      await node.http.close();
    }
  });
});
