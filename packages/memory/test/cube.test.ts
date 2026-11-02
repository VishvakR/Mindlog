import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { MemoryBlobStore } from '@mindlog/blob';
import { packTar, unpackTar } from '../src/cube/tar.js';
import { cogxTime } from '../src/cube/cogx.js';
import { ctx, memoryNode, scope } from './support/memory-node.js';

const enc = new TextEncoder();

describe('tar', () => {
  test('round-trips files of any content and size', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.stringMatching(/^[a-z]{1,20}\.(jsonl|json)$/),
            data: fc.uint8Array({ maxLength: 2000 }),
          }),
          { maxLength: 6 },
        ),
        (files) => {
          const out = unpackTar(packTar(files), { maxFiles: 10, maxBytes: 1 << 20 });
          expect(out).toEqual(files);
        },
      ),
    );
  });

  test('refuses unsafe names and archives over the limits', () => {
    const bad = packTar([{ name: '../etc/passwd', data: enc.encode('x') }]);
    expect(() => unpackTar(bad, { maxFiles: 10, maxBytes: 1 << 20 })).toThrow(/unsafe/);
    const many = packTar([1, 2, 3].map((i) => ({ name: `f${String(i)}`, data: new Uint8Array() })));
    expect(() => unpackTar(many, { maxFiles: 2, maxBytes: 1 << 20 })).toThrow(/too many/);
    const big = packTar([{ name: 'a', data: new Uint8Array(100_000) }]);
    expect(() => unpackTar(big, { maxFiles: 2, maxBytes: 10_000 })).toThrow();
  });
});

describe('memory cubes', () => {
  test('an exported scope imports into another with its memories, tags and validity', async () => {
    const blob = new MemoryBlobStore();
    const n = await memoryNode({ cold: blob });
    const a = await n.engine.remember(
      n.range,
      {
        scope: scope(),
        content: 'Ana lives in Lisbon.',
        kind: 'semantic',
        tags: ['home'],
        validFromMs: 1000,
      },
      ctx,
    );
    await n.engine.remember(
      n.range,
      { scope: scope(), content: 'Ana works at Acme.', kind: 'semantic' },
      ctx,
    );
    await n.engine.forget(
      n.range,
      { scope: scope(), ids: a.ok ? [a.value.ids[0] ?? ''] : [] },
      ctx,
    );
    await n.engine.remember(
      n.range,
      { scope: scope(), content: 'Ana likes tea.', kind: 'semantic' },
      ctx,
    );
    const cube = await n.engine.exportCube(n.range, scope());
    expect(cube.ok).toBe(true);
    if (!cube.ok) return;
    const imported = await n.engine.importCube(
      n.range,
      scope('u2'),
      { bytes: cube.value, format: 'mcube', name: 'backup.mcube' },
      ctx,
    );
    expect(imported.ok && imported.value).toMatchObject({ imported: 2, skipped: 0 });
    const listed = await n.engine.list(n.range, scope('u2'), { limit: 10 });
    const texts = listed.ok ? listed.value.memories.map((m) => m.text).sort() : [];
    expect(texts).toEqual(['Ana likes tea.', 'Ana works at Acme.']);
    // Imports come from a document and follow the trust policy: quarantined by default.
    expect(listed.ok && listed.value.memories[0]).toMatchObject({
      trust: 'quarantined',
      source: { type: 'document', ref: 'import:backup.mcube' },
    });
  });

  test('a cube whose files do not match its manifest is refused', async () => {
    const n = await memoryNode();
    await n.engine.remember(
      n.range,
      { scope: scope(), content: 'Ana likes tea.', kind: 'semantic' },
      ctx,
    );
    const cube = await n.engine.exportCube(n.range, scope());
    if (!cube.ok) throw new Error('export');
    const files = unpackTar(cube.value, { maxFiles: 10, maxBytes: 1 << 20 }).map((f) =>
      f.name === 'memories.jsonl' ? { ...f, data: enc.encode('{"text":"evil"}\n') } : f,
    );
    const r = await n.engine.importCube(
      n.range,
      scope('u2'),
      { bytes: packTar(files), format: 'mcube', name: 'x' },
      ctx,
    );
    expect(!r.ok && r.error.code).toBe('INVALID_ARGUMENT');
  });

  test('a COGX archive imports its memories, facts, blocks and episodes', async () => {
    const n = await memoryNode();
    const line = (o: object) => JSON.stringify(o) + '\n';
    const files = [
      {
        name: 'manifest.json',
        data: enc.encode(JSON.stringify({ cogx_version: '0.1', source_system: 'mem0' })),
      },
      {
        name: 'memories.jsonl',
        data: enc.encode(
          line({
            kind: 'memory',
            external_id: 'm1',
            content: 'Prefers window seats',
            categories: ['travel'],
          }),
        ),
      },
      {
        name: 'facts.jsonl',
        data: enc.encode(
          line({
            kind: 'fact',
            external_id: 'f1',
            subject_ref: 'Ana',
            predicate: 'lives_in',
            object_ref: 'Lisbon',
            valid_at: '2024-01-01T00:00:00',
          }),
        ),
      },
      {
        name: 'memory_blocks.jsonl',
        data: enc.encode(
          line({ kind: 'memory_block', external_id: 'b1', label: 'persona', value: 'Helpful' }),
        ),
      },
      {
        name: 'episodes.jsonl',
        data: enc.encode(
          line({
            kind: 'episode',
            external_id: 'e1',
            scope: { session_id: 's9' },
            turns: [{ role: 'user', content: 'hi there friend' }],
          }),
        ),
      },
    ];
    const r = await n.engine.importCube(
      n.range,
      scope(),
      { bytes: packTar(files), format: 'cogx', name: 'mem0.cogx' },
      ctx,
    );
    expect(r.ok && r.value.imported).toBe(4);
    const listed = await n.engine.list(n.range, scope(), { limit: 10 });
    const byText = new Map(listed.ok ? listed.value.memories.map((m) => [m.text, m]) : []);
    expect(byText.get('Prefers window seats')?.tags).toEqual(['travel']);
    expect(byText.get('Ana lives_in Lisbon')?.validFromMs).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(byText.get('persona: Helpful')).toBeDefined();
    expect(byText.get('user: hi there friend')).toMatchObject({ kind: 'episodic', session: 's9' });
  });

  test('a newer COGX major version is refused', async () => {
    const n = await memoryNode();
    const bytes = packTar([{ name: 'manifest.json', data: enc.encode('{"cogx_version":"1.0"}') }]);
    const r = await n.engine.importCube(
      n.range,
      scope(),
      { bytes, format: 'cogx', name: 'x' },
      ctx,
    );
    expect(!r.ok && r.error.message).toMatch(/newer/);
  });

  test('COGX timestamps: epoch units and naive ISO as UTC', () => {
    expect(cogxTime(1_700_000_000)).toBe(1_700_000_000_000);
    expect(cogxTime(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(cogxTime(1_700_000_000_000_000)).toBe(1_700_000_000_000);
    expect(cogxTime('2024-01-01T00:00:00')).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(cogxTime('2024-01-01')).toBe(Date.parse('2024-01-01'));
    expect(cogxTime('nope')).toBeUndefined();
  });
});
