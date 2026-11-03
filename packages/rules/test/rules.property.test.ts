import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { CompareOp, Expr, IndexInfo, Operand, RecordData, ScanPlan } from '@mindlog/rules';
import {
  COMPARE_OPS,
  compareValues,
  evaluateRule,
  parseRule,
  planScan,
  printRule,
} from '@mindlog/rules';
import { request, schema } from './fixtures.js';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 300);

/** Strips source positions so trees from different texts compare equal. */
function shape(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shape);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k]) => k !== 'from' && k !== 'to')
      .map(([k, v]) => [k, shape(v)]),
  );
}

const span = { from: 0, to: 0 };
const name = fc
  .stringMatching(/^[a-z_][a-z0-9_]{0,6}$/)
  .filter((s) => !['true', 'false', 'null'].includes(s));
const literal: fc.Arbitrary<Operand> = fc.oneof(
  fc.string({ maxLength: 8 }).map((value) => ({ kind: 'literal' as const, value, ...span })),
  fc
    .integer({ min: -1000, max: 1000 })
    .map((value) => ({ kind: 'literal' as const, value, ...span })),
  fc.constantFrom(true, false, null).map((value) => ({ kind: 'literal' as const, value, ...span })),
);
const ident: fc.Arbitrary<Operand> = fc
  .tuple(
    fc.constantFrom('record', 'request', 'collection'),
    fc.array(name, { minLength: 1, maxLength: 3 }),
    fc.option(fc.constantFrom('isset', 'changed', 'length', 'each', 'lower'), { nil: undefined }),
    name,
  )
  .map(([root, path, modifier, coll]) => {
    const r =
      root === 'record'
        ? { kind: 'record' as const }
        : root === 'request'
          ? { kind: 'request' as const }
          : { kind: 'collection' as const, collection: coll, alias: coll };
    const node = { kind: 'ident' as const, root: r, path, ...span };
    return modifier === undefined ? node : { ...node, modifier };
  });
const operand: fc.Arbitrary<Operand> = fc.oneof(
  literal,
  ident,
  fc.constantFrom('@now', '@year').map((n) => ({ kind: 'macro' as const, name: n, ...span })),
  fc
    .tuple(
      fc.constantFrom('geoDistance', 'strftime'),
      fc.array(fc.oneof(literal, ident), { maxLength: 3 }),
    )
    .map(([n, args]) => ({ kind: 'call' as const, name: n, args, ...span })),
);
const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ expr: Expr }>((tie) => ({
  expr: fc.oneof(
    { depthSize: 'small' },
    fc
      .tuple(operand, fc.constantFrom(...COMPARE_OPS), operand)
      .map(([left, op, right]) => ({ kind: 'compare' as const, op, left, right, ...span })),
    fc
      .tuple(fc.constantFrom('and' as const, 'or' as const), tie('expr'), tie('expr'))
      .map(([kind, left, right]) => ({ kind, left, right, ...span })),
  ),
})).expr;

describe('parser fuzzing', () => {
  test('printed trees parse back to the same tree', () => {
    fc.assert(
      fc.property(exprArb, (expr) => {
        const parsed = parseRule(printRule(expr));
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(shape(parsed.value)).toEqual(shape(expr));
      }),
      { numRuns: RUNS },
    );
  });

  test('arbitrary text never throws and errors stay inside the source', () => {
    const alphabet = fc.constantFrom(...'ab_.:@?=!<>~&|()\'" ,1-\n/'.split(''));
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: alphabet, maxLength: 40 })), (source) => {
        const parsed = parseRule(source);
        if (!parsed.ok) {
          expect(parsed.error.from).toBeGreaterThanOrEqual(0);
          expect(parsed.error.to).toBeLessThanOrEqual(source.length + 1);
        }
      }),
      { numRuns: RUNS * 10 },
    );
  });

  test('deep nesting is an error, not a stack overflow', () => {
    expect(parseRule('('.repeat(10_000) + 'a = 1' + ')'.repeat(10_000)).ok).toBe(false);
  });
});

describe('planner equivalence', () => {
  const INDEXES: IndexInfo[] = [
    { name: 'by_title', fields: [{ name: 'title', kind: 'text' }] },
    { name: 'by_views', fields: [{ name: 'views', kind: 'number' }] },
    {
      name: 'by_pub_views',
      fields: [
        { name: 'published', kind: 'bool' },
        { name: 'views', kind: 'number' },
      ],
    },
  ];
  const titles = ['', 'a', 'b', 'ab', '5'];
  const recordArb = fc.record({
    title: fc.constantFrom(...titles),
    views: fc.oneof(fc.integer({ min: -3, max: 3 }), fc.constant(null)),
    published: fc.boolean(),
  });
  const value = fc.oneof(
    fc.constantFrom<unknown>(...titles, null, true, false),
    fc.integer({ min: -3, max: 3 }),
  );
  const field = fc.constantFrom('title', 'views', 'published', 'id');
  const ops = fc.constantFrom<CompareOp>('=', '!=', '>', '>=', '<', '<=', '?=', '~');
  const cmp = fc.tuple(field, ops, value, fc.boolean()).map(([f, op, v, flipped]): Expr => {
    const lhs: Operand = { kind: 'ident', root: { kind: 'record' }, path: [f], ...span };
    const rhs: Operand = { kind: 'literal', value: v as string | number | boolean | null, ...span };
    return { kind: 'compare', op, left: flipped ? rhs : lhs, right: flipped ? lhs : rhs, ...span };
  });
  const rule = fc.letrec<{ e: Expr }>((tie) => ({
    e: fc.oneof(
      { depthSize: 'small' },
      cmp,
      fc
        .tuple(fc.constantFrom('and' as const, 'or' as const), tie('e'), tie('e'))
        .map(([kind, left, right]) => ({ kind, left, right, ...span })),
    ),
  })).e;

  /** What a typed index scan returns: exact typed equality on the prefix, then the bounds. */
  function candidates(plan: ScanPlan, rows: readonly RecordData[]): RecordData[] {
    if (plan.kind === 'scan') return [...rows];
    if (plan.kind === 'ids') return rows.filter((r) => plan.ids.includes(String(r['id'])));
    const index = INDEXES.find((i) => i.name === plan.index);
    return rows.filter((r) => {
      const fields = index?.fields ?? [];
      if (!plan.eq.every((v, i) => r[fields[i]?.name ?? ''] === v)) return false;
      const next = fields[plan.eq.length]?.name ?? '';
      return (plan.range ?? []).every((b) => compareValues(b.op, r[next], b.value));
    });
  }

  test('a planned scan finds exactly what a full scan finds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(recordArb, { maxLength: 12 }), rule, async (raw, expr) => {
        const rows = raw.map((r, i) => ({ ...r, id: `r${String(i)}`, collectionName: 'posts' }));
        const input = (record: RecordData | null) => ({
          collection: 'posts',
          record,
          request: request(),
          nowMs: 0,
          schema,
          resolver: { byIds: () => Promise.resolve([]), rows: () => Promise.resolve([]) },
        });
        const matches = async (list: readonly RecordData[]) => {
          const out: string[] = [];
          for (const r of list) {
            const res = await evaluateRule(expr, input(r));
            if (res.ok && res.value) out.push(String(r['id']));
          }
          return out;
        };
        const plan = await planScan(expr, INDEXES, input(null));
        expect(await matches(candidates(plan, rows))).toEqual(await matches(rows));
      }),
      { numRuns: RUNS },
    );
  });

  test('plans use the most specific index', async () => {
    const input = {
      collection: 'posts',
      record: null,
      request: request(),
      nowMs: 0,
      schema,
      resolver: { byIds: () => Promise.resolve([]), rows: () => Promise.resolve([]) },
    };
    const plan = async (source: string) => {
      const expr = parseRule(source);
      if (!expr.ok) throw new Error(expr.error.message);
      return planScan(expr.value, INDEXES, input);
    };
    expect(await plan('published = true && views > 1 && views <= 3')).toEqual({
      kind: 'index',
      index: 'by_pub_views',
      eq: [true],
      range: [
        { op: '>', value: 1 },
        { op: '<=', value: 3 },
      ],
    });
    expect(await plan("title = 'a' || views = 1")).toEqual({ kind: 'scan' });
    expect(await plan("id = 'r1' && title = 'a'")).toEqual({ kind: 'ids', ids: ['r1'] });
    expect(await plan("1 < views && title = ''")).toEqual({
      kind: 'index',
      index: 'by_views',
      eq: [],
      range: [{ op: '>', value: 1 }],
    });
  });
});
