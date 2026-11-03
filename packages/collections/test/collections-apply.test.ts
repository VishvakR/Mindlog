import { describe, expect, test } from 'vitest';
import type { MemoryStore } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import type { CollectionInput } from '@mindlog/collections';
import { indexPrefix, uniqueKey } from '@mindlog/collections';
import { TENANT, collectionsNode, op } from './support/collections-node.js';

const posts: CollectionInput = {
  name: 'posts',
  fields: [
    { name: 'title', type: 'text', required: true, max: 20 },
    { name: 'slug', type: 'text' },
    { name: 'views', type: 'number' },
    { name: 'tags', type: 'select', values: ['a', 'b'], maxSelect: 2 },
  ],
  indexes: [
    { name: 'by_slug', fields: ['slug'], unique: true },
    { name: 'by_views', fields: ['views'] },
  ],
  listRule: '',
};

const id = (n: number) => `rec${String(n).padStart(12, '0')}`;

async function rows(store: MemoryStore, index: string): Promise<number> {
  let n = 0;
  for await (const _ of new MvccReader(store).scan(indexPrefix(TENANT, 'posts', index))) n++;
  return n;
}

describe('schema changes', () => {
  test('create, conflict on a stale version, invalid schemas', async () => {
    const n = await collectionsNode();
    const created = await n.schema(posts);
    expect(created.outcome.case).toBe('record');
    const again = await n.schema(posts);
    expect(again.outcome.case === 'error' && again.outcome.value.code).toBe('CONFLICT');
    const bad = await n.schema({ name: 'x', fields: [{ name: 'id', type: 'text' }] }, 0n);
    expect(bad.outcome.case === 'error' && bad.outcome.value.fields).toEqual({
      'fields.0.name': 'id is a system field',
    });
    const badIndex = await n.schema({
      name: 'y',
      fields: [{ name: 't', type: 'json' }],
      indexes: [{ name: 'i', fields: ['t'] }],
    });
    expect(badIndex.outcome.case === 'error' && badIndex.outcome.value.fields).toEqual({
      'indexes.0.fields': 't cannot be indexed',
    });
  });

  test('changing indexes rewrites rows; a violated unique index refuses the change', async () => {
    const n = await collectionsNode();
    const v1 = await n.schema({ ...posts, indexes: [] });
    if (v1.outcome.case !== 'record') throw new Error('schema');
    await n.write('posts', [
      op('create', id(1), { title: 'a', slug: 's' }),
      op('create', id(2), { title: 'b', slug: 's' }),
    ]);
    expect(await rows(n.store, 'by_slug')).toBe(0);
    const refused = await n.schema(posts, v1.outcome.value.versions[0]);
    expect(refused.outcome.case === 'error' && refused.outcome.value.code).toBe('ALREADY_EXISTS');
    const relaxed = await n.schema(
      { ...posts, indexes: [{ name: 'by_slug', fields: ['slug'] }] },
      v1.outcome.value.versions[0],
    );
    expect(relaxed.outcome.case).toBe('record');
    expect(await rows(n.store, 'by_slug')).toBe(2);
  });

  test('removing a field drops its values; deleting the collection deletes its records', async () => {
    const n = await collectionsNode();
    const v1 = await n.schema(posts);
    if (v1.outcome.case !== 'record') throw new Error('schema');
    await n.write('posts', [op('create', id(1), { title: 'a', views: 3 })]);
    const v2 = await n.schema(
      { ...posts, fields: posts.fields?.filter((f) => f.name !== 'views'), indexes: [] },
      v1.outcome.value.versions[0],
    );
    if (v2.outcome.case !== 'record') throw new Error(JSON.stringify(v2.outcome.value));
    expect((await n.read('posts', id(1)))?.data).toEqual({ title: 'a', slug: '', tags: [] });
    await n.drop('posts', v2.outcome.value.versions[0] ?? 0n);
    expect(await n.read('posts', id(1))).toBeUndefined();
  });
});

describe('record writes', () => {
  test('creates fill zero values and maintain index rows', async () => {
    const n = await collectionsNode();
    await n.schema(posts);
    const r = await n.write('posts', [op('create', id(1), { title: 'Hi', views: 2, slug: 'hi' })]);
    expect(r.outcome.case).toBe('record');
    const rec = await n.read('posts', id(1));
    expect(rec?.data).toEqual({ title: 'Hi', slug: 'hi', views: 2, tags: [] });
    expect(rec?.stored.version).toBe(
      r.outcome.case === 'record' ? r.outcome.value.versions[0] : -1n,
    );
    expect(await rows(n.store, 'by_views')).toBe(1);
    const claim = await new MvccReader(n.store).get(uniqueKey(TENANT, 'posts', 'by_slug', ['hi']));
    expect(new TextDecoder().decode(claim)).toBe(id(1));
  });

  test('validation failures carry per-field messages and write nothing', async () => {
    const n = await collectionsNode();
    await n.schema(posts);
    const r = await n.write('posts', [
      op('create', id(1), { title: 'ok' }),
      op('create', id(2), { title: '', views: 'x', tags: ['z'], extra: 1 }),
    ]);
    expect(r.outcome.case === 'error' && r.outcome.value.fields).toEqual({
      title: 'cannot be blank',
      views: 'must be a number',
      tags: 'z is not an allowed value',
      extra: 'unknown field',
    });
    expect(await n.read('posts', id(1))).toBeUndefined();
  });

  test('unique claims: taken, released on update and delete, empty values unclaimed', async () => {
    const n = await collectionsNode();
    await n.schema(posts);
    const a = await n.write('posts', [
      op('create', id(1), { title: 'a', slug: 'x' }),
      op('create', id(3), { title: 'c' }),
    ]);
    const taken = await n.write('posts', [op('create', id(2), { title: 'b', slug: 'x' })]);
    expect(taken.outcome.case === 'error' && taken.outcome.value).toMatchObject({
      code: 'ALREADY_EXISTS',
      fields: { slug: 'must be unique' },
    });
    expect((await n.write('posts', [op('create', id(4), { title: 'd' })])).outcome.case).toBe(
      'record',
    );
    const v1 = a.outcome.case === 'record' ? (a.outcome.value.versions[0] ?? 0n) : 0n;
    const renamed = await n.write('posts', [op('update', id(1), { title: 'a', slug: 'y' }, v1)]);
    expect(renamed.outcome.case).toBe('record');
    expect(
      (await n.write('posts', [op('create', id(2), { title: 'b', slug: 'x' })])).outcome.case,
    ).toBe('record');
    const v2 = renamed.outcome.case === 'record' ? (renamed.outcome.value.versions[0] ?? 0n) : 0n;
    await n.write('posts', [op('delete', id(1), undefined, v2)]);
    expect(
      (await n.write('posts', [op('create', id(5), { title: 'e', slug: 'y' })])).outcome.case,
    ).toBe('record');
  });

  test('version fences, missing records and duplicate ids', async () => {
    const n = await collectionsNode();
    await n.schema(posts);
    await n.write('posts', [op('create', id(1), { title: 'a' })]);
    const stale = await n.write('posts', [op('update', id(1), { title: 'b' }, 1n)]);
    expect(stale.outcome.case === 'error' && stale.outcome.value.code).toBe('CONFLICT');
    const missing = await n.write('posts', [op('update', id(9), { title: 'b' }, 1n)]);
    expect(missing.outcome.case === 'error' && missing.outcome.value.code).toBe('NOT_FOUND');
    const dup = await n.write('posts', [
      op('create', id(2), { title: 'a' }),
      op('create', id(2), { title: 'a' }),
    ]);
    expect(dup.outcome.case === 'error' && dup.outcome.value.code).toBe('INVALID_ARGUMENT');
    const exists = await n.write('posts', [op('create', id(1), { title: 'a' })]);
    expect(exists.outcome.case === 'error' && exists.outcome.value.code).toBe('ALREADY_EXISTS');
    const noColl = await n.write('nope', [op('create', id(1), { title: 'a' })]);
    expect(noColl.outcome.case === 'error' && noColl.outcome.value.code).toBe('NOT_FOUND');
  });

  test('views take only upserts and deletes', async () => {
    const n = await collectionsNode();
    await n.schema(posts);
    const view = await n.schema({
      name: 'stats',
      type: 'view',
      fields: [{ name: 'total', type: 'number' }],
      view: { from: 'posts', select: { total: 'count(posts.id)' } },
    });
    expect(view.outcome.case).toBe('record');
    expect((await n.write('stats', [op('create', id(1), { total: 1 })])).outcome.case).toBe(
      'error',
    );
    expect((await n.write('stats', [op('upsert', id(1), { total: 1 })])).outcome.case).toBe(
      'record',
    );
    expect((await n.write('posts', [op('upsert', id(1), { title: 'x' })])).outcome.case).toBe(
      'error',
    );
  });

  test('auth collections get the auth fields and a unique email', async () => {
    const n = await collectionsNode();
    expect((await n.schema({ name: 'users', type: 'auth' })).outcome.case).toBe('record');
    const user = { email: 'a@b.io', password: '$argon2id$v=19$x', tokenKey: 'k' };
    expect((await n.write('users', [op('create', id(1), user)])).outcome.case).toBe('record');
    const dup = await n.write('users', [op('create', id(2), user)]);
    expect(dup.outcome.case === 'error' && dup.outcome.value.fields).toEqual({
      email: 'must be unique',
    });
    const plain = await n.write('users', [
      op('create', id(3), { ...user, email: 'c@d.io', password: 'hunter22' }),
    ]);
    expect(plain.outcome.case === 'error' && plain.outcome.value.fields).toEqual({
      password: 'must be a password hash',
    });
  });
});
