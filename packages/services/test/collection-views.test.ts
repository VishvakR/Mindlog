import { create } from '@bufbuild/protobuf';
import { expect, test } from 'vitest';
import { collectionScope } from '@mindlog/jobs';
import { JobSchema } from '@mindlog/proto';
import { VIEW_JOB, collectionWorkers } from '@mindlog/services';
import { TENANT, collectionsNode } from './support/collections-node.js';

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: { message: string; fields?: unknown } },
): T => {
  if (!r.ok) throw new Error(`${r.error.message} ${JSON.stringify(r.error.fields)}`);
  return r.value;
};

test('a view materializes a join with a group, and follows its sources', async () => {
  const n = await collectionsNode();
  const su = n.superuser;
  ok(
    await n.collections.saveCollection(su, {
      name: 'posts',
      fields: [{ name: 'title', type: 'text' }],
    }),
  );
  ok(
    await n.collections.saveCollection(su, {
      name: 'comments',
      fields: [
        { name: 'post', type: 'relation', collection: 'posts' },
        { name: 'stars', type: 'number' },
      ],
    }),
  );
  const bad = await n.collections.saveCollection(su, {
    name: 'broken',
    type: 'view',
    fields: [{ name: 'n', type: 'number' }],
    view: { from: 'posts', group: ['posts.id'], select: { n: 'posts.title' } },
  });
  expect(!bad.ok && bad.error.fields).toEqual({ 'view.select.n': 'must be aggregated or grouped' });
  const a = ok(await n.collections.create(su, 'posts', { title: 'a' })).raw.id;
  const b = ok(await n.collections.create(su, 'posts', { title: 'b' })).raw.id;
  const c1 = ok(await n.collections.create(su, 'comments', { post: a, stars: 4 })).raw.id;
  ok(await n.collections.create(su, 'comments', { post: a, stars: 2 }));
  ok(
    await n.collections.saveCollection(su, {
      name: 'post_stats',
      type: 'view',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'total', type: 'number' },
        { name: 'avg', type: 'number' },
      ],
      view: {
        from: 'posts',
        join: [{ collection: 'comments', on: { field: 'post', equals: 'id' }, type: 'left' }],
        group: ['posts.id', 'posts.title'],
        select: { title: 'posts.title', total: 'count(comments.id)', avg: 'avg(comments.stars)' },
      },
      listRule: '',
    }),
  );
  n.collections.catalog.invalidate(TENANT);
  const rows = async () => {
    const list = ok(await n.collections.list(n.anonymous, 'post_stats', { sort: 'title' }));
    return list.items.map((i) => [i['title'], i['total'], i['avg']]);
  };
  expect(await rows()).toEqual([
    ['a', 2, 3],
    ['b', 0, 0],
  ]);
  const before = ok(await n.collections.list(n.anonymous, 'post_stats', { sort: 'title' }))
    .items[0]?.['id'];

  const worker = collectionWorkers({ collections: n.collections }).find((w) => w.kind === VIEW_JOB);
  const refresh = async (source: string) => {
    const job = create(JobSchema, { id: 'j', kind: VIEW_JOB });
    ok(
      await (worker as NonNullable<typeof worker>).run({
        rangeId: 1n,
        tenant: TENANT,
        user: collectionScope(source),
        job,
        attempt: 1,
      }),
    );
  };
  ok(await n.collections.delete(su, 'comments', c1));
  await refresh('comments');
  expect(await rows()).toEqual([
    ['a', 1, 2],
    ['b', 0, 0],
  ]);
  expect(
    ok(await n.collections.list(n.anonymous, 'post_stats', { sort: 'title' })).items[0]?.['id'],
  ).toBe(before);
  ok(await n.collections.delete(su, 'posts', b));
  await refresh('posts');
  expect(await rows()).toEqual([['a', 1, 2]]);

  const write = await n.collections.create(su, 'post_stats', { title: 'x' });
  expect(!write.ok && write.error.message).toBe('View collections are read-only.');
  const drop = await n.collections.deleteCollection(su, 'posts');
  expect(!drop.ok && drop.error.message).toContain('post_stats');
});
