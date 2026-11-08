import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { MemoryBlobStore } from '@mindlog/blob';
import { collectionScope } from '@mindlog/jobs';
import { JobSchema } from '@mindlog/proto';
import { CASCADE_JOB, FILES_JOB, RecordFiles, collectionWorkers } from '@mindlog/services';
import { TENANT, collectionsNode } from './support/collections-node.js';

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

async function setup() {
  const n = await collectionsNode();
  const blob = new MemoryBlobStore();
  const files = new RecordFiles({ collections: n.collections, blob, auth: n.auth, clock: n.clock });
  const workers = collectionWorkers({ collections: n.collections, files });
  const run = async (kind: string, collection: string, payload = '') => {
    const worker = workers.find((w) => w.kind === kind);
    if (!worker) throw new Error(kind);
    const job = create(JobSchema, { id: 'j', kind, payload: new TextEncoder().encode(payload) });
    ok(
      await worker.run({
        rangeId: 1n,
        tenant: TENANT,
        user: collectionScope(collection),
        job,
        attempt: 1,
      }),
    );
  };
  return { ...n, blob, files, run };
}

describe('relation cascades', () => {
  test('cascading fields delete, others drop the id, required ones refuse the delete', async () => {
    const n = await setup();
    const save = async (input: Parameters<typeof n.collections.saveCollection>[1]) =>
      ok(await n.collections.saveCollection(n.superuser, input));
    await save({ name: 'teams' });
    await save({
      name: 'tasks',
      fields: [{ name: 'team', type: 'relation', collection: 'teams', cascadeDelete: true }],
    });
    await save({
      name: 'notes',
      fields: [{ name: 'teams', type: 'relation', collection: 'teams', maxSelect: 3 }],
    });
    await save({
      name: 'pins',
      fields: [{ name: 'team', type: 'relation', collection: 'teams', required: true }],
    });
    const make = async (c: string, body: Record<string, unknown>) =>
      ok(await n.collections.create(n.superuser, c, body)).raw.id;
    const [a, b] = [await make('teams', {}), await make('teams', {})];
    const task = await make('tasks', { team: a });
    const note = await make('notes', { teams: [a, b] });
    const pin = await make('pins', { team: a });
    const refused = await n.collections.delete(n.superuser, 'teams', a);
    expect(!refused.ok && refused.error.message).toBe('The record is required by pins.team.');
    ok(await n.collections.delete(n.superuser, 'pins', pin));
    ok(await n.collections.delete(n.superuser, 'teams', a));
    await n.run(CASCADE_JOB, 'teams', a);
    expect((await n.collections.view(n.superuser, 'tasks', task)).ok).toBe(false);
    expect(ok(await n.collections.view(n.superuser, 'notes', note))['teams']).toEqual([b]);
    // A retried job finds nothing left to do.
    await n.run(CASCADE_JOB, 'teams', a);
  });
});

describe('file janitor', () => {
  test('removes unreferenced files after the grace period, keeps live and young ones', async () => {
    const n = await setup();
    ok(
      await n.collections.saveCollection(n.superuser, {
        name: 'docs',
        fields: [{ name: 'file', type: 'file', thumbs: ['8x8'] }],
      }),
    );
    const upload = (name: string) => ({
      field: 'file',
      filename: name,
      mimetype: 'text/plain',
      bytes: new Uint8Array([1]),
    });
    const live = ok(await n.files.create(n.superuser, 'docs', {}, [upload('live.txt')]));
    const gone = ok(await n.files.create(n.superuser, 'docs', {}, [upload('gone.txt')]));
    ok(await n.collections.delete(n.superuser, 'docs', gone.raw.id));
    const dir = n.blob.keys()[0]?.split('/').slice(0, -1).join('/') ?? '';
    await n.blob.put(
      `${dir.replace('files/', 'thumbs/')}/8x8_${String(gone.record['file'])}`,
      new Uint8Array([2]),
    );
    await n.run(FILES_JOB, 'docs');
    expect(n.blob.keys().filter((k) => k.startsWith('files/'))).toHaveLength(2);
    expect(n.blob.keys().filter((k) => k.startsWith('thumbs/'))).toHaveLength(0);
    n.clock.advance(11n * 60_000n);
    await n.run(FILES_JOB, 'docs');
    expect(n.blob.keys()).toEqual([`${dir}/${String(live.record['file'])}`]);
  });

  test('a refused write leaves no blob', async () => {
    const n = await setup();
    ok(
      await n.collections.saveCollection(n.superuser, {
        name: 'docs',
        fields: [
          { name: 'file', type: 'file' },
          { name: 'n', type: 'number', required: true },
        ],
      }),
    );
    const bad = await n.files.create(n.superuser, 'docs', { n: 0 }, [
      { field: 'file', filename: 'a.txt', mimetype: 'text/plain', bytes: new Uint8Array([1]) },
    ]);
    expect(bad.ok).toBe(false);
    expect(n.blob.keys()).toEqual([]);
  });
});
