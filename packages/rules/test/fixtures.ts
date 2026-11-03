import type {
  FieldInfo,
  RecordData,
  RecordResolver,
  RequestInfo,
  RowHint,
  SchemaView,
} from '@mindlog/rules';
import { compareValues } from '@mindlog/rules';

const sys: FieldInfo[] = [
  { name: 'id', kind: 'text', multi: false },
  { name: 'created', kind: 'autodate', multi: false },
  { name: 'updated', kind: 'autodate', multi: false },
  { name: 'collectionName', kind: 'text', multi: false },
];

export const FIELDS: Readonly<Record<string, FieldInfo[]>> = {
  users: [
    ...sys,
    { name: 'name', kind: 'text', multi: false },
    { name: 'email', kind: 'email', multi: false },
    { name: 'role', kind: 'select', multi: false },
    { name: 'teams', kind: 'relation', multi: true, collection: 'teams' },
    { name: 'tokenKey', kind: 'text', multi: false, hidden: true },
  ],
  teams: [...sys, { name: 'name', kind: 'text', multi: false }],
  posts: [
    ...sys,
    { name: 'title', kind: 'text', multi: false },
    { name: 'author', kind: 'relation', multi: false, collection: 'users' },
    { name: 'tags', kind: 'select', multi: true },
    { name: 'views', kind: 'number', multi: false },
    { name: 'published', kind: 'bool', multi: false },
    { name: 'meta', kind: 'json', multi: false },
    { name: 'place', kind: 'geoPoint', multi: false },
  ],
  members: [
    ...sys,
    { name: 'user', kind: 'relation', multi: false, collection: 'users' },
    { name: 'team', kind: 'relation', multi: false, collection: 'teams' },
  ],
};

export const schema: SchemaView = {
  fields: (c) => FIELDS[c],
  collections: () => Object.keys(FIELDS).sort(),
  authCollections: () => ['users'],
};

export type Db = Record<string, RecordData[]>;

export function resolverOf(db: Db): RecordResolver & { rowCalls: RowHint[][] } {
  const rowCalls: RowHint[][] = [];
  return {
    rowCalls,
    byIds: (c, ids) => Promise.resolve((db[c] ?? []).filter((r) => ids.includes(String(r['id'])))),
    rows: (c, hints, limit) => {
      rowCalls.push([...hints]);
      const rows = (db[c] ?? []).filter((r) =>
        hints.every((h) => h.values.some((v) => compareValues('?=', r[h.field], v))),
      );
      return Promise.resolve(rows.slice(0, limit));
    },
  };
}

export const db: Db = {
  users: [
    {
      id: 'u1',
      collectionName: 'users',
      name: 'Ann',
      email: 'ann@x.io',
      role: 'admin',
      teams: ['t1', 't2'],
    },
    { id: 'u2', collectionName: 'users', name: 'Bob', email: 'bob@x.io', role: '', teams: [] },
  ],
  teams: [
    { id: 't1', collectionName: 'teams', name: 'Red' },
    { id: 't2', collectionName: 'teams', name: 'Blue' },
  ],
  posts: [
    {
      id: 'p1',
      collectionName: 'posts',
      title: 'Hello World',
      author: 'u1',
      tags: ['a', 'b'],
      views: 10,
      published: true,
      created: '2026-01-02 03:04:05.000Z',
      meta: { lang: 'en', score: 3 },
      place: { lon: 13.4, lat: 52.5 },
    },
    {
      id: 'p2',
      collectionName: 'posts',
      title: '',
      author: 'u2',
      tags: [],
      views: 0,
      published: false,
    },
  ],
  members: [
    { id: 'm1', collectionName: 'members', user: 'u1', team: 't1' },
    { id: 'm2', collectionName: 'members', user: 'u2', team: 't2' },
  ],
};

export function request(over: Partial<RequestInfo> = {}): RequestInfo {
  return {
    auth: null,
    body: {},
    query: {},
    headers: {},
    method: 'GET',
    context: 'default',
    ...over,
  };
}

export const ann = db['users']?.[0] ?? {};
export const bob = db['users']?.[1] ?? {};
