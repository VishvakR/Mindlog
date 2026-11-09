import { describe, expect, test } from 'vitest';
import type { CollectionInput, CollectionSchema, FieldDef, ViewDef } from '@mindlog/collections';
import {
  checkSchema,
  checkView,
  collectionSchema,
  computeView,
  fieldNormalize,
  fieldSchema,
  fieldValidate,
  fieldZero,
  indexesOf,
  parseSchema,
  schemaView,
} from '@mindlog/collections';

const schema = (input: CollectionInput): CollectionSchema => collectionSchema.parse(input);
const field = (raw: Record<string, unknown>): FieldDef => fieldSchema.parse({ name: 'f', ...raw });
const view = (raw: Record<string, unknown>) => raw as ViewDef;

describe('computeView', () => {
  const posts = [
    { id: 'p1', title: 'a', views: 3 },
    { id: 'p2', title: 'b', views: 5 },
    { id: 'p3', title: 'a', views: 7 },
  ];
  const tags = [
    { id: 't1', post: 'p1', name: 'x' },
    { id: 't2', post: ['p1', 'p2'], name: 'y' },
  ];
  const sources = new Map<string, Record<string, unknown>[]>([
    ['posts', posts],
    ['tags', tags],
  ]);
  const rows = (def: ViewDef) => [...computeView(def, sources).values()];

  test('groups with every aggregate, and ids survive a recompute', () => {
    const def = view({
      from: 'posts',
      join: [],
      group: ['posts.title'],
      select: {
        t: 'posts.title',
        n: 'count(posts.id)',
        s: 'sum(posts.views)',
        a: 'avg(posts.views)',
        lo: 'min(posts.views)',
        hi: 'max(posts.views)',
      },
    });
    expect(rows(def)).toEqual([
      { t: 'a', n: 2, s: 10, a: 5, lo: 3, hi: 7 },
      { t: 'b', n: 1, s: 5, a: 5, lo: 5, hi: 5 },
    ]);
    expect([...computeView(def, sources).keys()]).toEqual([...computeView(def, sources).keys()]);
  });

  test('joins: inner drops unmatched rows, left keeps them, lists match each value', () => {
    const select = { p: 'posts.id', tag: 'tags.name' };
    const on = { field: 'post', equals: 'id' };
    expect(
      rows(
        view({
          from: 'posts',
          join: [{ collection: 'tags', on, type: 'inner' }],
          group: [],
          select,
        }),
      ),
    ).toHaveLength(3);
    expect(
      rows(
        view({
          from: 'posts',
          join: [{ collection: 'tags', on, type: 'left' }],
          group: [],
          select,
        }),
      ),
    ).toContainEqual({ p: 'p3', tag: null });
  });

  test('aggregates over nothing, and a missing source', () => {
    const def = view({ from: 'empty', join: [], group: [], select: { n: 'count(empty.id)' } });
    expect(rows(def)).toEqual([]);
    const one = new Map([['posts', [{ id: 'p', views: 'text' }]]]);
    const out = computeView(
      view({
        from: 'posts',
        join: [],
        group: ['posts.id'],
        select: { a: 'avg(posts.views)', m: 'min(posts.nope)', bad: 'nonsense' },
      }),
      one,
    );
    expect([...out.values()]).toEqual([{ a: 0, m: null }]);
  });
});

describe('checkView', () => {
  const posts = schema({ name: 'posts', fields: [{ name: 'title', type: 'text' }] });
  const other = schema({
    name: 'other',
    type: 'view',
    fields: [],
    view: { from: 'posts', select: {} },
  });
  const all = new Map([
    ['posts', posts],
    ['other', other],
  ]);
  const check = (def: Record<string, unknown>, fields = [{ name: 'x', type: 'text' as const }]) =>
    checkView(schema({ name: 'v', type: 'view', fields, view: def as ViewDef }), all);

  test.each([
    [{ from: 'ghost', select: {} }, { view: 'no collection ghost' }],
    [{ from: 'other', select: {} }, { view: 'a view cannot read another view' }],
    [
      {
        from: 'posts',
        join: [{ collection: 'posts', on: { field: 'nope', equals: 'id' } }],
        select: {},
      },
      { 'view.join.0.on': 'unknown field' },
    ],
    [
      { from: 'posts', group: ['posts.nope'], select: {} },
      { 'view.group': 'unknown field posts.nope' },
    ],
    [
      { from: 'posts', select: { x: 'nonsense' } },
      { 'view.select.x': 'invalid expression nonsense' },
    ],
    [
      { from: 'posts', select: { y: 'posts.title' } },
      { 'view.select.y': 'is not a field of the view' },
    ],
    [{ from: 'posts', select: { x: 'posts.title' } }, {}],
  ])('%j', (def, want) => {
    expect(check(def)).toEqual(want);
  });

  test('a view reading itself, and a schema without a pipeline', () => {
    const self = schema({
      name: 'posts',
      type: 'view',
      fields: [],
      view: { from: 'posts', select: {} },
    });
    expect(checkView(self, all)['view']).toBe('a view cannot read itself');
    expect(checkView(posts, all)).toEqual({});
  });
});

describe('schema checks', () => {
  const fieldsOf = (input: CollectionInput) => {
    const p = parseSchema(input);
    const c = p.ok ? checkSchema(p.value) : p;
    return c.ok ? {} : c.error.fields;
  };

  test.each([
    [
      { name: 'a', fields: [{ name: 'p', type: 'password' }] },
      { 'fields.0.type': 'password fields belong to auth collections' },
    ],
    [
      { name: 'a', fields: [{ name: 'v', type: 'vector', source: 'nope' }] },
      { 'fields.0.source': 'must name a text or editor field' },
    ],
    [
      { name: 'a', fields: [{ name: 't', type: 'text', pattern: '(' }] },
      { 'fields.0.pattern': 'invalid regular expression' },
    ],
    [
      {
        name: 'a',
        fields: [
          { name: 't', type: 'text' },
          { name: 't', type: 'text' },
        ],
      },
      { 'fields.1.name': 'duplicate field t' },
    ],
    [
      {
        name: 'a',
        indexes: [
          { name: 'i', fields: ['id'] },
          { name: 'i', fields: ['nope'] },
        ],
      },
      { 'indexes.1.name': 'duplicate index i', 'indexes.1.fields': 'unknown field nope' },
    ],
    [{ name: 'a', type: 'view' }, { view: 'a view collection needs a view pipeline' }],
    [
      { name: 'a', view: { from: 'b', select: {} } },
      { view: 'only view collections have a pipeline' },
    ],
    [
      { name: 'a', manageRule: '' },
      { type: 'manageRule and auth options belong to auth collections' },
    ],
    [{ name: '1bad' }, { name: 'letters, digits and _ only, not starting with a digit' }],
    [
      {
        name: 'a',
        fields: [{ name: 's', type: 'select', values: ['x'], maxSelect: 2 }],
        indexes: [{ name: 'i', fields: ['s'] }],
      },
      { 'indexes.0.fields': 's cannot be indexed' },
    ],
  ])('%j', (input, want) => {
    expect(fieldsOf(input as CollectionInput)).toEqual(want);
  });

  test('auth collections get default options and a unique email index', () => {
    const p = parseSchema({ name: 'u', type: 'auth' });
    const c = p.ok ? checkSchema(p.value) : p;
    if (!c.ok) throw new Error('schema');
    expect(c.value.auth?.otp.enabled).toBe(false);
    expect(indexesOf(c.value)[0]).toEqual({ name: '_email', fields: ['email'], unique: true });
    const view2 = schemaView(new Map([['u', c.value]]));
    expect(view2.fields('nope')).toBeUndefined();
    expect(view2.authCollections()).toEqual(['u']);
    expect(view2.collections()).toEqual(['u']);
  });
});

describe('field values', () => {
  const ok = (raw: Record<string, unknown>, value: unknown) => {
    const f = field(raw);
    expect(fieldValidate(f, fieldNormalize(f, value))).toBeUndefined();
  };
  const bad = (raw: Record<string, unknown>, value: unknown) => {
    const f = field(raw);
    return fieldValidate(f, value);
  };

  test('accepted values', () => {
    ok({ type: 'text', min: 1, max: 3, pattern: '^a' }, 'ab');
    ok({ type: 'text' }, 5);
    ok({ type: 'text' }, null);
    ok({ type: 'number', min: 1, max: 3, onlyInt: true }, '2');
    ok({ type: 'number' }, '');
    ok({ type: 'number' }, true);
    ok({ type: 'bool' }, 1);
    ok({ type: 'bool' }, 'false');
    ok({ type: 'bool', required: true }, '1');
    ok({ type: 'email', onlyDomains: ['x.io'] }, 'a@x.io');
    ok({ type: 'email' }, null);
    ok({ type: 'url' }, 'https://x.io');
    ok({ type: 'url' }, null);
    ok({ type: 'editor', maxSize: 100 }, '<b>x</b>');
    ok({ type: 'date' }, 1_700_000_000_000);
    ok({ type: 'date' }, '');
    ok({ type: 'autodate' }, '2026-01-01');
    ok({ type: 'select', values: ['a', 'b'], maxSelect: 2 }, ['a', 'b']);
    ok({ type: 'select', values: ['a'] }, '');
    ok({ type: 'relation', collection: 'u' }, 'aaaaaaaaaaaaaaa');
    ok({ type: 'relation', collection: 'u', maxSelect: 2, minSelect: 1 }, []);
    ok({ type: 'file' }, 'a.png');
    ok({ type: 'json', maxSize: 100 }, '{"a":1}');
    ok({ type: 'json' }, 'not json');
    ok({ type: 'json', required: true }, [1]);
    ok({ type: 'geoPoint' }, { lon: 1, lat: 2 });
    ok({ type: 'geoPoint' }, '');
    ok({ type: 'vector', source: 's', dimensions: 2 }, [1, 2]);
    ok({ type: 'vector', source: 's' }, '');
    ok({ type: 'memory' }, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    ok({ type: 'memory' }, null);
    ok({ type: 'password' }, '$argon2id$x');
  });

  test.each([
    [{ type: 'text' }, 5, 'must be text'],
    [{ type: 'text', min: 3 }, 'a', 'at least 3 characters'],
    [{ type: 'number', max: 1 }, 2, 'must be at most 1'],
    [{ type: 'number' }, NaN, 'must be a number'],
    [{ type: 'number', required: true }, 0, 'cannot be blank'],
    [{ type: 'bool' }, 'x', 'must be true or false'],
    [{ type: 'email' }, 5, 'must be text'],
    [{ type: 'email', required: true }, '', 'cannot be blank'],
    [{ type: 'url' }, 5, 'must be text'],
    [{ type: 'url' }, 'not a url', 'invalid URL'],
    [{ type: 'url', required: true }, '', 'cannot be blank'],
    [{ type: 'editor' }, 5, 'must be text'],
    [{ type: 'editor' }, '<script>', 'contains disallowed HTML'],
    [{ type: 'editor', maxSize: 1 }, 'ab', 'at most 1 bytes'],
    [{ type: 'date', required: true }, '', 'cannot be blank'],
    [{ type: 'autodate' }, 5, 'must be a date'],
    [{ type: 'select', values: ['a'], maxSelect: 2 }, 'a', 'must be a list of strings'],
    [{ type: 'select', values: ['a'] }, 5, 'must be a string'],
    [{ type: 'select', values: ['a', 'b'], maxSelect: 2 }, ['a', 'a'], 'values must be unique'],
    [{ type: 'select', values: ['a'], maxSelect: 2 }, ['a', 'b', 'c'], 'at most 2 values'],
    [{ type: 'select', values: ['a'], required: true }, '', 'cannot be blank'],
    [{ type: 'file' }, '.hidden', '.hidden is not a file name'],
    [{ type: 'json', required: true }, null, 'cannot be blank'],
    [{ type: 'geoPoint' }, 'x', 'must be {lon, lat}'],
    [{ type: 'geoPoint', required: true }, { lon: 0, lat: 0 }, 'cannot be blank'],
    [{ type: 'vector', source: 's' }, ['a'], 'must be a list of numbers'],
    [{ type: 'vector', source: 's', required: true }, null, 'cannot be blank'],
    [{ type: 'memory', required: true }, '', 'cannot be blank'],
    [{ type: 'password' }, 'plain', 'must be a password hash'],
    [{ type: 'password', required: true }, '', 'cannot be blank'],
  ])('%j refuses %j', (raw, value, message) => {
    expect(bad(raw, value)).toBe(message);
  });

  test('values that cannot be converted, and zero values', () => {
    expect(fieldNormalize(field({ type: 'text' }), {})).toBeUndefined();
    expect(fieldNormalize(field({ type: 'number' }), 'x')).toBeUndefined();
    expect(fieldNormalize(field({ type: 'bool' }), 'maybe')).toBeUndefined();
    expect(fieldNormalize(field({ type: 'email' }), 5)).toBeUndefined();
    expect(fieldNormalize(field({ type: 'url' }), 5)).toBeUndefined();
    expect(fieldNormalize(field({ type: 'editor' }), {})).toBeUndefined();
    expect(fieldNormalize(field({ type: 'date' }), 'never')).toBeUndefined();
    expect(fieldNormalize(field({ type: 'select', values: ['a'] }), [1])).toBeUndefined();
    expect(fieldNormalize(field({ type: 'file' }), [1])).toBeUndefined();
    expect(fieldNormalize(field({ type: 'relation', collection: 'u' }), [1])).toBeUndefined();
    expect(fieldNormalize(field({ type: 'geoPoint' }), 5)).toBeUndefined();
    expect(fieldNormalize(field({ type: 'password' }), 5)).toBeUndefined();
    expect(fieldNormalize(field({ type: 'memory' }), 5)).toBeUndefined();
    expect(fieldNormalize(field({ type: 'json' }), undefined)).toBeNull();
    expect(fieldZero(field({ type: 'file', maxSelect: 2 }))).toEqual([]);
    expect(fieldZero(field({ type: 'relation', collection: 'u', maxSelect: 2 }))).toEqual([]);
    expect(fieldZero(field({ type: 'select', values: ['a'], maxSelect: 2 }))).toEqual([]);
    for (const type of ['date', 'autodate', 'memory', 'password', 'email', 'url', 'editor'])
      expect(fieldZero(field({ type }))).toBe('');
    expect(fieldZero(field({ type: 'geoPoint' }))).toEqual({ lon: 0, lat: 0 });
    expect(fieldZero(field({ type: 'vector', source: 's' }))).toBeNull();
  });
});
