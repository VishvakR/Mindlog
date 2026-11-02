import { describe, expect, test } from 'vitest';
import type { RecallItem } from '@/lib/memory';
import {
  formatScope,
  parseScope,
  parseSse,
  presentSignals,
  radialLayout,
  retrieverColumns,
  versionChanges,
} from '@/lib/memory';

describe('scopes', () => {
  test('user[/agent[/session]] parses and prints back', () => {
    expect(parseScope('alice')).toEqual({ user: 'alice' });
    expect(parseScope('alice/helper/s1')).toEqual({
      user: 'alice',
      agent: 'helper',
      session: 's1',
    });
    expect(parseScope(' alice / helper ')).toEqual({ user: 'alice', agent: 'helper' });
    expect(parseScope('')).toEqual({ user: '' });
    expect(formatScope({ user: 'alice', agent: 'helper' })).toBe('alice/helper');
    expect(formatScope({ user: '' })).toBe('(tenant-wide)');
  });
});

describe('radialLayout', () => {
  const nodes = [
    { id: 'person:ana', depth: 0 },
    { id: 'org:acme', depth: 1 },
    { id: 'place:lisbon', depth: 1 },
    { id: 'place:portugal', depth: 2 },
  ];

  test('puts the entity in the centre and each depth on its own ring', () => {
    const layout = radialLayout(nodes, 400, 300);
    const at = (id: string) => layout.get(id) ?? { x: NaN, y: NaN };
    expect(at('person:ana')).toEqual({ x: 200, y: 150 });
    const r = (id: string) => Math.hypot(at(id).x - 200, at(id).y - 150);
    expect(r('org:acme')).toBeCloseTo(r('place:lisbon'), 6);
    expect(r('place:portugal')).toBeGreaterThan(r('org:acme'));
    expect(Math.max(...[...layout.values()].map((p) => Math.abs(p.y - 150)))).toBeLessThanOrEqual(
      150,
    );
  });

  test('is deterministic and spreads a ring evenly', () => {
    const a = radialLayout(nodes, 400, 300);
    expect(radialLayout(nodes, 400, 300)).toEqual(a);
    const one = a.get('org:acme');
    const two = a.get('place:lisbon');
    expect(one && two && Math.round(Math.hypot(one.x - two.x, one.y - two.y))).toBeGreaterThan(50);
  });
});

describe('recall explain helpers', () => {
  const item = (id: string, text: string, signals: Partial<RecallItem['signals']>): RecallItem => ({
    memory: {
      id,
      user: 'u',
      kind: 'semantic',
      text,
      entities: [],
      links: [],
      source: { type: 'user', principal: 'p' },
      trust: 'normal',
      importance: 0.5,
      tags: [],
      createdAtMs: 0,
      tier: 'hot',
      pinned: false,
      version: 1,
      strength: 1,
      recallCount: 0,
    },
    score: 0.5,
    signals: { fused: 1, recency: 1, importance: 0.5, retention: 1, ...signals },
  });

  test('retriever columns follow the pipeline order and show text for returned memories', () => {
    const cols = retrieverColumns(
      {
        items: [item('a', 'Ana likes tea', { vector: 0.9 })],
        explain: { lists: { ppr: ['b', 'a'], vector: ['a'], keyword: [] }, themes: [] },
      },
      1,
    );
    expect(cols.map((c) => c.name)).toEqual(['vector', 'keyword', 'ppr']);
    expect(cols[0]?.rows).toEqual([{ id: 'a', text: 'Ana likes tea', rank: 1 }]);
    expect(cols[2]).toEqual({ name: 'ppr', total: 2, rows: [{ id: 'b', rank: 1 }] });
  });

  test('only signals some item carries are shown', () => {
    expect(
      presentSignals([item('a', 'x', { vector: 0.2 }), item('b', 'y', { rerank: 3, ppr: 0.1 })]),
    ).toEqual(['vector', 'ppr', 'rerank']);
  });
});

describe('parseSse', () => {
  test('splits complete events, skips comments and keeps the unfinished rest', () => {
    const text =
      ': mindlog change stream\n\nid: 1:4\nevent: memory.added\ndata: {"a":1}\n\nevent: resync\ndata: {}\n\nid: 1:5\nda';
    const { events, rest } = parseSse(text);
    expect(events).toEqual([
      { event: 'memory.added', id: '1:4', data: '{"a":1}' },
      { event: 'resync', data: '{}' },
    ]);
    expect(rest).toBe('id: 1:5\nda');
    expect(parseSse(rest + 'ta: {}\n\n').events).toEqual([
      { event: 'message', id: '1:5', data: '{}' },
    ]);
  });
});

describe('versionChanges', () => {
  const base = {
    id: 'm',
    user: 'u',
    kind: 'semantic',
    text: 'Ana likes tea.',
    entities: [],
    links: [],
    source: { type: 'user', principal: 'p' },
    trust: 'normal',
    importance: 0.5,
    tags: [],
    createdAtMs: 0,
    tier: 'hot' as const,
    pinned: false,
    version: 1,
    strength: 1,
    recallCount: 0,
  };

  test('lists the fields, meta keys and links that changed', () => {
    const after = {
      ...base,
      tags: ['tea'],
      tier: 'cold' as const,
      meta: { context: 'drinks' },
      links: [{ to: 'x', relation: 'supersedes', weight: 1 }],
    };
    expect(versionChanges(base, after)).toEqual([
      'tier: hot → cold',
      'tags: [] → ["tea"]',
      'meta.context: — → drinks',
      'link + supersedes → x',
    ]);
    expect(versionChanges(base, { ...base, recallCount: 3 })).toEqual([]);
  });
});
