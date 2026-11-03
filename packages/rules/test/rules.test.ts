import { describe, expect, test } from 'vitest';
import type { RecordData, RequestInfo } from '@mindlog/rules';
import {
  ParseCache,
  checkRule,
  completeRule,
  evaluateRule,
  parseRule,
  printRule,
} from '@mindlog/rules';
import { ann, bob, db, request, resolverOf, schema } from './fixtures.js';

const NOW = Date.UTC(2026, 0, 15, 12, 30, 45, 500);

async function holds(
  rule: string,
  record: RecordData | null,
  req: RequestInfo = request(),
  collection = 'posts',
): Promise<boolean> {
  const expr = parseRule(rule);
  if (!expr.ok) throw new Error(expr.error.message);
  const result = await evaluateRule(expr.value, {
    collection,
    record,
    request: req,
    nowMs: NOW,
    schema,
    resolver: resolverOf(db),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const p1 = db['posts']?.[0] ?? null;
const p2 = db['posts']?.[1] ?? null;

describe('parser', () => {
  test.each([
    ['a = \'x\' && b > 1 || c ~ "y"', "((a = 'x' && b > 1) || c ~ 'y')"],
    ['a = 1 && (b = 2 || c = 3)', '(a = 1 && (b = 2 || c = 3))'],
    ['@request.auth.id != "" // comment\n && x ?= true', "(@request.auth.id != '' && x ?= true)"],
    [
      '@collection.members:m.user ?= @request.auth.id',
      '@collection.members:m.user ?= @request.auth.id',
    ],
    ['@request.body.title:changed = false', '@request.body.title:changed = false'],
    [
      'geoDistance(place.lon, place.lat, 13.4, -52.5) < 25',
      'geoDistance(place.lon, place.lat, 13.4, -52.5) < 25',
    ],
    ["title = 'it\\'s'", "title = 'it\\'s'"],
    ['NULL = null', 'null = null'],
  ])('%s', (source, printed) => {
    const parsed = parseRule(source);
    expect(parsed.ok && printRule(parsed.value)).toBe(printed);
  });

  test.each([
    ['', 'empty expression'],
    ['// only a comment', 'empty expression'],
    ['a =', 'expected a field'],
    ['a = 1 &&', 'expected a field'],
    ['(a = 1', 'expected )'],
    ['a = 1)', 'expected && or ||'],
    ["a = 'x", 'unterminated string'],
    ['a # 1', 'unexpected character'],
    ['a:bogus = 1', 'unknown modifier'],
    ['@nope.x = 1', 'unknown identifier @nope'],
    ['a:lower.b = 1', 'last field only'],
  ])('rejects %j', (source, message) => {
    const parsed = parseRule(source);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain(message);
      expect(parsed.error.from).toBeGreaterThanOrEqual(0);
      expect(parsed.error.to).toBeLessThanOrEqual(source.length + 1);
    }
  });

  test('the cache returns the same tree', () => {
    const cache = new ParseCache();
    expect(cache.parse('a = 1')).toBe(cache.parse('a = 1'));
  });
});

describe('evaluator semantics (PocketBase-compatible)', () => {
  test.each([
    // null fallback: missing, null and '' are equal
    ["title = ''", p2, true],
    ['title = null', p2, true],
    ["title != ''", p1, true],
    ['missing = null', p1, true],
    // numbers and bools
    ['views > 5 && views <= 10', p1, true],
    ['views > 5', p2, false],
    ['published = true', p1, true],
    ['published = false', p2, true],
    ['views >= null', p1, false],
    // ~ is a case-insensitive contains, or a LIKE pattern with %
    ["title ~ 'world'", p1, true],
    ["title ~ 'hell%'", p1, true],
    ["title ~ 'world%'", p1, false],
    ["title !~ 'xyz'", p1, true],
    // multi-value: plain needs every value, ? needs any
    ["tags = 'a'", p1, false],
    ["tags ?= 'a'", p1, true],
    ["tags ?= 'z'", p1, false],
    ["tags != 'z'", p1, true],
    ['tags:length = 2', p1, true],
    ["tags:each ~ '%'", p1, true],
    // empty multi-value compares as one null
    ['tags = null', p2, true],
    ["tags ?= 'a'", p2, false],
    // relations
    ["author.name = 'Ann'", p1, true],
    ["author.teams.name ?= 'Blue'", p1, true],
    ["author.teams.name = 'Blue'", p1, false],
    ["author.teams.name:lower ?= 'red'", p1, true],
    // json and geo
    ["meta.lang = 'en' && meta.score > 2", p1, true],
    ['meta.nested.deep = null', p1, true],
    ['geoDistance(place.lon, place.lat, 13.4, 52.52) < 5', p1, true],
    ['geoDistance(place.lon, place.lat, 0, 0) < 5', p1, false],
    // macros and functions
    ['created < @now', p1, true],
    ['@year = 2026 && @month = 1 && @day = 15 && @hour = 12', p1, true],
    ["@todayStart = '2026-01-15 00:00:00.000Z'", p1, true],
    ["strftime('%Y-%m', created) = '2026-01'", p1, true],
    ["strftime('%Y-%m-%d', created, '+1 month', 'start of month') = '2026-02-01'", p1, true],
    // grouping
    ["(title = 'x' || views = 10) && published = true", p1, true],
    ["title = 'x' || views = 10 && published = false", p1, false],
  ])('%s', async (rule, record, expected) => {
    expect(await holds(rule, record)).toBe(expected);
  });

  test('@request.auth for users and guests', async () => {
    const asAnn = request({ auth: ann });
    expect(await holds('author = @request.auth.id', p1, asAnn)).toBe(true);
    expect(await holds('author = @request.auth.id', p2, asAnn)).toBe(false);
    expect(await holds("@request.auth.id != ''", p1, request())).toBe(false);
    expect(await holds("@request.auth.id = ''", p1, request())).toBe(true);
    expect(await holds("@request.auth.teams.name ?= 'Red'", p1, asAnn)).toBe(true);
    expect(await holds("@request.auth.role = 'admin'", p1, request({ auth: bob }))).toBe(false);
    expect(await holds("@request.auth.collectionName = 'users'", p1, asAnn)).toBe(true);
  });

  test('@request.body, :isset, :changed, query, headers, method, context', async () => {
    const req = request({
      body: { title: 'Hello World', views: 11, tags: ['a'], author: 'u2' },
      query: { page: '2' },
      headers: { x_token: 'abc' },
      method: 'PATCH',
      context: 'realtime',
    });
    expect(await holds('@request.body.title:changed = false', p1, req)).toBe(true);
    expect(await holds('@request.body.views:changed = true', p1, req)).toBe(true);
    expect(await holds('@request.body.published:isset = false', p1, req)).toBe(true);
    expect(await holds('@request.body.tags:length = 1', p1, req)).toBe(true);
    expect(await holds("@request.body.author.name = 'Bob'", p1, req)).toBe(true);
    expect(
      await holds("@request.query.page = '2' && @request.headers.x_token = 'abc'", p1, req),
    ).toBe(true);
    expect(
      await holds("@request.query.page:isset = true && @request.method = 'PATCH'", p1, req),
    ).toBe(true);
    expect(await holds("@request.context = 'realtime'", p1, req)).toBe(true);
  });

  test('@collection aliases bind one row for the whole expression', async () => {
    const asAnn = request({ auth: ann });
    // u1 is in t1 only through members; m1 = (u1, t1), m2 = (u2, t2).
    const same = "@collection.members.user ?= @request.auth.id && @collection.members.team ?= 't1'";
    const other =
      "@collection.members.user ?= @request.auth.id && @collection.members.team ?= 't2'";
    expect(await holds(same, p1, asAnn)).toBe(true);
    expect(await holds(other, p1, asAnn)).toBe(false);
    // two aliases join independently
    const two = "@collection.members:a.user ?= 'u1' && @collection.members:b.team ?= 't2'";
    expect(await holds(two, p1, asAnn)).toBe(true);
    // a plain operator needs every row of the collection
    expect(await holds("@collection.teams.name != 'Green'", p1)).toBe(true);
    expect(await holds("@collection.teams.name = 'Red'", p1)).toBe(false);
  });

  test('alias rows are narrowed by ?= hints', async () => {
    const resolver = resolverOf(db);
    const expr = parseRule("@collection.members.user ?= @request.auth.id && title != ''");
    if (!expr.ok) throw new Error('parse');
    await evaluateRule(expr.value, {
      collection: 'posts',
      record: p1,
      request: request({ auth: ann }),
      nowMs: NOW,
      schema,
      resolver,
    });
    expect(resolver.rowCalls).toEqual([[{ field: 'user', values: ['u1'] }]]);
  });

  test('evaluation errors carry a position', async () => {
    const expr = parseRule('title.x = 1');
    if (!expr.ok) throw new Error('parse');
    const result = await evaluateRule(expr.value, {
      collection: 'posts',
      record: p1,
      request: request(),
      nowMs: NOW,
      schema,
      resolver: resolverOf(db),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ from: 0, to: 7 });
  });
});

describe('checker', () => {
  const check = (rule: string, allowHidden = false): string[] => {
    const expr = parseRule(rule);
    if (!expr.ok) throw new Error(expr.error.message);
    return checkRule(expr.value, { collection: 'posts', schema, allowHidden }).map(
      (i) => i.message,
    );
  };

  test('accepts valid rules', () => {
    expect(
      check(
        "author = @request.auth.id && @request.auth.teams.name ?= 'x' && @collection.members.user ?= author && tags:length > 0 && meta.any.path = 1 && @request.body.title:changed = false && strftime('%Y', created, 'start of day') = '2026' && @now > created",
      ),
    ).toEqual([]);
  });

  test.each([
    ['nope = 1', 'unknown field nope in posts'],
    ['title.name = 1', 'title is not a relation field'],
    ['author.tokenKey = 1', 'tokenKey cannot be filtered on'],
    ['@collection.ghosts.id = 1', 'unknown collection ghosts'],
    ['@request.whatever = 1', 'unknown @request.whatever'],
    ['@request.auth.nope = 1', 'unknown field'],
    ['title:isset = true', ':isset works on'],
    ['@request.query.x:changed = true', ':changed works on'],
    ['views:length = 1', ':length needs a multi-value field'],
    ['@soon = 1', 'unknown macro @soon'],
    ['lower(title) = 1', 'unknown function lower'],
    ['geoDistance(1, 2) = 1', 'geoDistance takes 4–4 arguments'],
    ["strftime('%Y', created, 'next tuesday') = 1", 'unsupported strftime modifier'],
  ])('%s', (rule, message) => {
    expect(check(rule).join('; ')).toContain(message);
  });

  test('hidden fields are allowed for superusers', () => {
    expect(check('author.tokenKey = 1', true)).toEqual([]);
  });
});

describe('completion', () => {
  const labels = (source: string, cursor = source.length): string[] =>
    completeRule(source, cursor, 'posts', schema).items.map((i) => i.label);

  test('root fields, macros and prefixes', () => {
    expect(labels('ti')).toEqual(['title']);
    expect(labels('@to')).toEqual(['@tomorrow', '@todayStart', '@todayEnd']);
    expect(labels('x = @request.')).toContain('auth.');
  });

  test('relation paths, auth fields and collections', () => {
    expect(labels('author.te')).toEqual(['teams.', 'teams']);
    expect(labels('@request.auth.na')).toEqual(['name']);
    expect(labels('@collection.mem')).toEqual(['members.']);
    expect(labels('@collection.members.us')).toEqual(['user.', 'user']);
  });

  test('modifiers after a colon', () => {
    expect(labels('tags:le')).toEqual(['length']);
    const c = completeRule('tags:le = 1', 7, 'posts', schema);
    expect([c.from, c.to]).toEqual([5, 7]);
  });
});
