import { JobRunner, WorkerRegistry } from '@mindlog/jobs';
import { describe, expect, test } from 'vitest';
import type { MemoryConfig, RememberInput } from '@mindlog/memory';
import { trustOf } from '@mindlog/memory';
import { ctx, memoryNode, scope } from './support/memory-node.js';

type Node = Awaited<ReturnType<typeof memoryNode>>;

const policy = { trustedTools: ['calendar'], trustedDomains: ['example.org'] };

describe('trust policy (PLAN 13.4)', () => {
  test.each([
    [{ type: 'user' }, 'normal'],
    [{ type: 'agent' }, 'normal'],
    [{ type: 'tool', ref: 'calendar' }, 'normal'],
    [{ type: 'tool', ref: 'shell' }, 'quarantined'],
    [{ type: 'tool' }, 'quarantined'],
    [{ type: 'web', ref: 'https://docs.example.org/page' }, 'normal'],
    [{ type: 'web', ref: 'example.org' }, 'normal'],
    [{ type: 'web', ref: 'https://example.org.evil.com/' }, 'quarantined'],
    [{ type: 'document', ref: 'notes.pdf' }, 'quarantined'],
    [{ type: 'web' }, 'quarantined'],
  ] as const)('%j is %s', (source, trust) => {
    expect(trustOf(source, policy)).toBe(trust);
  });
});

function runner(n: Node) {
  const workers = new WorkerRegistry();
  workers.register(n.engine.enrichWorker());
  return new JobRunner({
    rangeId: 1n,
    state: n.store,
    proposer: n.replica,
    stamper: n.stamper,
    active: () => true,
    clock: n.clock,
    logger: n.logger,
    metrics: n.metrics,
    workers,
  });
}

async function remember(n: Node, content: string, extra: Partial<RememberInput> = {}) {
  const r = await n.engine.remember(n.range, { scope: scope(), content, ...extra }, ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function live(n: Node): Promise<string[]> {
  const r = await n.engine.list(n.range, scope(), { limit: 50 });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.memories.map((m) => m.text);
}

const node = (config: Partial<MemoryConfig> = {}) =>
  memoryNode({ config: { trustedDomains: ['example.org'], ...config } });

describe('taint cascade', () => {
  test('forgetting a source forgets what came from it and what was derived from that', async () => {
    const n = await node();
    const source = { type: 'web', ref: 'https://example.org/post' } as const;
    await remember(n, 'Ana moved to Porto. Ana works at Acme.', { source, async: true });
    await remember(n, 'I prefer dark roast coffee.', { kind: 'semantic' });
    expect(await runner(n).runOnce()).toBe(1);
    expect(await live(n)).toHaveLength(4);

    const r = await n.engine.forget(
      n.range,
      { scope: scope(), ids: [], sourceRef: source.ref, reason: 'bad source' },
      ctx,
    );
    expect(r.ok && r.value.count).toBe(3);
    expect(await live(n)).toEqual(['I prefer dark roast coffee.']);
  });

  test('a cascade past the limit forgets nothing', async () => {
    const n = await node({ maxCascade: 2 });
    const source = { type: 'web', ref: 'https://example.org/post' } as const;
    await remember(n, 'Ana moved to Porto. Ana works at Acme.', { source, async: true });
    await runner(n).runOnce();
    const r = await n.engine.forget(
      n.range,
      { scope: scope(), ids: [], sourceRef: source.ref },
      ctx,
    );
    expect(!r.ok && r.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await live(n)).toHaveLength(3);
  });

  test('derived memories are no more trusted than their inputs', async () => {
    const n = await node();
    await remember(n, 'Ana moved to Porto.', {
      source: { type: 'web', ref: 'https://elsewhere.net/' },
      async: true,
    });
    await runner(n).runOnce();
    const r = await n.engine.list(n.range, scope(), { limit: 10 });
    expect(r.ok && r.value.memories.map((m) => m.trust)).toEqual(['quarantined', 'quarantined']);
  });
});
