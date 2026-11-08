import { describe, expect, test } from 'vitest';
import {
  ParseCache,
  checkRule,
  evaluateRule,
  geoDistance,
  macroValue,
  operandValues,
  parseRule,
  parseTime,
  planScan,
  strftime,
} from '@mindlog/rules';
import type { Expr, RecordData } from '@mindlog/rules';
import { ann, db, request, resolverOf, schema } from './fixtures.js';

const NOW = Date.UTC(2026, 2, 15, 12, 30, 45, 500);
const p1 = db['posts']?.[0] ?? null;

const parsed = (rule: string): Expr => {
  const e = parseRule(rule);
  if (!e.ok) throw new Error(e.error.message);
  return e.value;
};
const input = (record: RecordData | null, over = {}) => ({
  collection: 'posts',
  record,
  request: request(over),
  nowMs: NOW,
  schema,
  resolver: resolverOf(db),
});
const run = (rule: string, record: RecordData | null = p1, over = {}) =>
  evaluateRule(parsed(rule), input(record, over));

test.each([
  ['@now', '2026-03-15 12:30:45.500Z'],
  ['@yesterday', '2026-03-14 12:30:45.500Z'],
  ['@tomorrow', '2026-03-16 12:30:45.500Z'],
  ['@second', 45],
  ['@minute', 30],
  ['@hour', 12],
  ['@day', 15],
  ['@month', 3],
  ['@weekday', 0],
  ['@year', 2026],
  ['@todayStart', '2026-03-15 00:00:00.000Z'],
  ['@todayEnd', '2026-03-15 23:59:59.999Z'],
  ['@monthStart', '2026-03-01 00:00:00.000Z'],
  ['@monthEnd', '2026-03-31 23:59:59.999Z'],
  ['@yearStart', '2026-01-01 00:00:00.000Z'],
  ['@yearEnd', '2026-12-31 23:59:59.999Z'],
  ['@nope', undefined],
])('macro %s', (name, value) => {
  expect(macroValue(name, NOW)).toBe(value);
});

describe('functions', () => {
  test('strftime formats and modifiers', () => {
    const t = '2026-03-15 12:30:45.500Z';
    expect(strftime('%Y-%m-%d %H:%M:%S %f %j %w %s %% %q', t, [])).toBe(
      `2026-03-15 12:30:45 45.500 074 0 ${String(Math.floor(Date.parse('2026-03-15T12:30:45.500Z') / 1000))} % %q`,
    );
    expect(strftime('%Y-%m-%d', t, ['start of year'])).toBe('2026-01-01');
    expect(strftime('%d', t, ['start of day', '+2 days'])).toBe('17');
    expect(strftime('%H', t, ['-3 hours'])).toBe('09');
    expect(strftime('%M', t, ['10 minutes'])).toBe('40');
    expect(strftime('%S', t, ['1 second'])).toBe('46');
    expect(strftime('%Y', t, ['1 year', 'utc'])).toBe('2027');
    expect(strftime('%Y', t, ['next week'])).toBeNull();
    expect(strftime('%Y', t, ['next week', 'utc'])).toBeNull();
    expect(strftime('%Y', 'garbage', [])).toBeNull();
    expect(strftime('%Y', 0, [])).toBe('1970');
  });

  test('times and distances', () => {
    expect(parseTime('')).toBeUndefined();
    expect(parseTime(Infinity)).toBeUndefined();
    expect(parseTime(null)).toBeUndefined();
    expect(parseTime('2026-01-01T00:00:00Z')).toBe(Date.UTC(2026, 0, 1));
    expect(geoDistance(0, 0, 0, 0)).toBe(0);
  });
});

describe('evaluation edge cases', () => {
  test.each([
    ['@soon = 1', 'unknown macro'],
    ['nope(1) = 1', 'unknown function'],
    ['geoDistance(1, 2) = 1', 'geoDistance takes 4'],
    ['strftime() = 1', 'strftime takes a format'],
    ['@request.method.x = 1', 'has no fields'],
    ['@request.query = 1', 'expected @request.query'],
    ['@request.auth = 1', 'expected @request.auth'],
    ['@request.body = 1', 'expected @request.body'],
    ['@request.body.title.x = 1', 'is not a relation'],
    ['@request.bogus = 1', 'unknown @request.bogus'],
    ['title:isset = true', ':isset works on'],
    ['@request.query.a:changed = true', ':changed works on @request.body'],
    ['@collection.a.x ?= 1 && @collection.b:a.x ?= 1', 'names two collections'],
  ])('%s fails with a position', async (rule, message) => {
    const r = await run(rule);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain(message);
  });

  test('values of mixed types compare like PocketBase', async () => {
    const r = { id: 'x', title: '5', views: 5, published: true, meta: { a: 1 }, tags: [] };
    for (const [rule, want] of [
      ["views = '5'", true],
      ['title = 5', true],
      ['published = 1', true],
      ['meta = \'{"a":1}\'', true],
      ["title > '4'", true],
      ['views < 6', true],
      ['views >= 5 && views <= 5', true],
      ['views != 5', false],
      ["views ~ '5'", true],
      ["title !~ '5'", false],
      ['tags:length = 0', true],
      ["title:lower = '5'", true],
      ['views:lower = 5', true],
    ] as const) {
      expect(await run(rule, r)).toEqual({ ok: true, value: want });
    }
  });

  test('a null record, an unknown auth owner and json digging', async () => {
    expect(await run('title = null', null)).toEqual({ ok: true, value: true });
    expect(await run('meta.lang.deep = null')).toEqual({ ok: true, value: true });
    expect(await run("@request.body.tags ?= 'x'", p1, { body: { tags: ['x', 'y'] } })).toEqual({
      ok: true,
      value: true,
    });
    expect(await run("@request.body.title = ''", p1, { body: {} })).toEqual({
      ok: true,
      value: true,
    });
    expect(await run("@request.body.author.name = ''", p1, { body: { author: 5 } })).toEqual({
      ok: true,
      value: true,
    });
    expect(await run("@request.body.tags.x = ''", p1, { body: { tags: [1, ''] } })).toMatchObject({
      ok: false,
    });
    expect(await run("@request.auth.name = 'Ann'", p1, { auth: ann })).toEqual({
      ok: true,
      value: true,
    });
    expect(await run("strftime('%Y', created) ?= '2026'")).toEqual({ ok: true, value: true });
    expect(await run('author.name.a.b.c = 1')).toMatchObject({ ok: false });
  });

  test('alias limits', async () => {
    const many = {
      ...db,
      teams: Array.from({ length: 1001 }, (_, i) => ({ id: `t${String(i)}`, name: 'n' })),
    };
    const big = { ...input(p1), resolver: resolverOf(many) };
    const a = await evaluateRule(parsed("@collection.teams.name ?= 'n'"), big);
    expect(!a.ok && a.error.message).toContain('over 1000 rows');
    const b = await evaluateRule(parsed("@collection.teams.name = 'n'"), big);
    expect(!b.ok && b.error.message).toContain('over 1000 rows');
    const pairs = {
      ...db,
      teams: Array.from({ length: 200 }, (_, i) => ({ id: `t${String(i)}`, name: 'n' })),
    };
    const c = await evaluateRule(
      parsed("@collection.teams:a.name ?= 'n' && @collection.teams:b.name ?= 'n'"),
      { ...input(p1), resolver: resolverOf(pairs) },
    );
    expect(!c.ok && c.error.message).toContain('row combinations');
  });

  test('operand values and hints from empty values', async () => {
    expect(await operandValues({ kind: 'literal', value: 1, from: 0, to: 0 }, input(p1))).toEqual({
      ok: true,
      value: [1],
    });
    const bad = await operandValues({ kind: 'macro', name: '@nope', from: 0, to: 0 }, input(p1));
    expect(bad.ok).toBe(false);
    const resolver = resolverOf(db);
    await evaluateRule(
      parsed("@collection.members.user ?= '' && @collection.members.team ?= @collection.teams.id"),
      { ...input(p1), resolver },
    );
    expect(resolver.rowCalls.flat()).toEqual([]);
  });
});

describe('checker and planner edges', () => {
  const check = (rule: string) =>
    checkRule(parsed(rule), { collection: 'posts', schema, allowHidden: false }).map(
      (i) => i.message,
    );

  test.each([
    ['@request.method.x = 1', 'has no fields'],
    ['@request.query.a.b = 1', 'expected @request.query'],
    ['@request.auth = 1', 'expected @request.auth'],
    ['@request.body = 1', 'expected @request.body'],
    ['strftime(1, created) = 1', 'needs a quoted format'],
    ['strftime() = 1', 'strftime takes'],
    ['@request.auth.teams.nope = 1', 'unknown field nope'],
    ['tags:each = 1 && views:each = 1', ':each needs'],
    ['geoDistance(@soon, 1, 1, 1) = 1', 'unknown macro'],
  ])('%s', (rule, message) => {
    expect(check(rule).join(';')).toContain(message);
  });

  test('no auth collections, and valid request paths', () => {
    const none = { ...schema, authCollections: () => [] };
    expect(
      checkRule(parsed('@request.auth.id = 1'), {
        collection: 'posts',
        schema: none,
        allowHidden: false,
      })[0]?.message,
    ).toBe('there are no auth collections');
    expect(
      check(
        "@request.method = 'GET' && @request.headers.x = 1 && @request.query.q:isset = true && @request.body.title:lower = 'x'",
      ),
    ).toEqual([]);
  });

  test('plans ignore values an index could miss', async () => {
    const indexes = [
      { name: 'i', fields: [{ name: 'views', kind: 'number' as const }] },
      { name: 'p', fields: [{ name: 'published', kind: 'bool' as const }] },
      { name: 'j', fields: [{ name: 'meta', kind: 'json' as const }] },
    ];
    const plan = (rule?: string) =>
      planScan(rule === undefined ? undefined : parsed(rule), indexes, input(null));
    expect(await plan()).toEqual({ kind: 'scan' });
    expect(await plan("views = '5'")).toEqual({ kind: 'scan' });
    expect(await plan('views = null')).toEqual({ kind: 'scan' });
    expect(await plan('published = 1')).toEqual({ kind: 'scan' });
    expect(await plan('meta = 1')).toEqual({ kind: 'scan' });
    expect(await plan('views:lower = 1')).toEqual({ kind: 'scan' });
    expect(await plan('author.views = 1')).toEqual({ kind: 'scan' });
    expect(await plan('views = title')).toEqual({ kind: 'scan' });
    expect(await plan('views ~ 1')).toEqual({ kind: 'scan' });
    expect(await plan("id ?= 'a'")).toEqual({ kind: 'ids', ids: ['a'] });
    expect(await plan('published = true')).toEqual({ kind: 'index', index: 'p', eq: [true] });
    expect(await plan('@year = 2026')).toEqual({ kind: 'scan' });
  });

  test('the parse cache drops its oldest entry and keeps errors', () => {
    const cache = new ParseCache();
    const first = cache.parse('a = 0');
    for (let i = 1; i <= 500; i++) cache.parse(`a = ${String(i)}`);
    expect(cache.parse('a = 0')).not.toBe(first);
    expect(cache.parse('(').ok).toBe(false);
  });
});
