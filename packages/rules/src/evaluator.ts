import { err, ok } from '@mindlog/core';
import type { Result } from '@mindlog/core';
import { conjuncts, comparisons, identsOf, isAnyOp } from './ast.js';
import type { CompareNode, Expr, IdentNode, Operand, RuleIssue, Span } from './ast.js';
import { geoDistance, strftime } from './functions.js';
import { macroValue } from './macros.js';
import { fieldOf, isObjectKind } from './schema.js';
import type { SchemaView } from './schema.js';
import { compareValues } from './values.js';

/** A record as rules see it: field name → value, with `id` and `collectionName`. */
export type RecordData = Readonly<Record<string, unknown>>;

/** The request a rule is evaluated for (`@request.*`). */
export interface RequestInfo {
  /** The authenticated record (with `collectionName`), or `null` for guests and superusers. */
  readonly auth: RecordData | null;
  readonly body: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, string>>;
  /** Lower-cased names with `-` as `_`, as in PocketBase. */
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  /** `default`, `realtime`, `protectedFile`, `password`, `otp`, `oauth2`. */
  readonly context: string;
}

/** Records of `collection` whose `field` equals one of `values` (rule equality). */
export interface RowHint {
  readonly field: string;
  readonly values: readonly unknown[];
}

/** Reads records for relation hops and `@collection` joins. */
export interface RecordResolver {
  /** The records with these ids; missing ids are skipped. */
  byIds(collection: string, ids: readonly string[]): Promise<RecordData[]>;
  /** Up to `limit` records matching every hint; returning more than match is fine. */
  rows(collection: string, hints: readonly RowHint[], limit: number): Promise<RecordData[]>;
}

export interface EvalInput {
  /** The collection the rule belongs to (the type of `record`). */
  readonly collection: string;
  /** The record the rule is about: the stored one, or the new one for a create. */
  readonly record: RecordData | null;
  readonly request: RequestInfo;
  readonly nowMs: number;
  readonly schema: SchemaView;
  readonly resolver: RecordResolver;
}

/** Bounds from ADR-0018. */
export const MAX_ALIAS_ROWS = 1000;
export const MAX_BINDINGS = 10_000;
export const MAX_HOPS = 6;

class EvalError extends Error {
  constructor(readonly issue: RuleIssue) {
    super(issue.message);
  }
}

const fail = (span: Span, message: string): never => {
  throw new EvalError({ message, from: span.from, to: span.to });
};

/** The values an operand stands for; `all` operands need every value to match a plain operator. */
interface Values {
  readonly values: readonly unknown[];
  readonly multi: boolean;
  /** Function results over several inputs match when any one does (PocketBase `geoDistance`). */
  readonly any?: boolean;
}

const single = (value: unknown): Values => ({ values: [value], multi: false });

/** Evaluates a rule for one record; errors are rules that cannot be evaluated (too many rows, …). */
export async function evaluateRule(
  expr: Expr,
  input: EvalInput,
): Promise<Result<boolean, RuleIssue>> {
  try {
    const scope = await bindAliases(expr, input);
    for (const binding of scope.bindings) {
      const ctx: Ctx = { input, binding, allRows: scope.allRows };
      if (await test(expr, ctx)) return ok(true);
    }
    return ok(false);
  } catch (e) {
    if (e instanceof EvalError) return err(e.issue);
    throw e;
  }
}

/** Values of an operand that does not depend on `@collection` rows, for planners. */
export async function operandValues(
  operand: Operand,
  input: EvalInput,
): Promise<Result<readonly unknown[], RuleIssue>> {
  try {
    const values = await valuesOf(
      operand,
      { input, binding: new Map(), allRows: new Map() },
      false,
    );
    return ok(values.values);
  } catch (e) {
    if (e instanceof EvalError) return err(e.issue);
    throw e;
  }
}

interface Ctx {
  readonly input: EvalInput;
  /** The row each `@collection` alias is bound to (`null`: the collection is empty). */
  readonly binding: ReadonlyMap<string, RecordData | null>;
  /** Every candidate row per alias, for plain operators on `@collection` fields. */
  readonly allRows: ReadonlyMap<string, readonly RecordData[]>;
}

async function test(expr: Expr, ctx: Ctx): Promise<boolean> {
  switch (expr.kind) {
    case 'and':
      return (await test(expr.left, ctx)) && test(expr.right, ctx);
    case 'or':
      return (await test(expr.left, ctx)) || test(expr.right, ctx);
    case 'compare':
      return compare(expr, ctx);
  }
}

async function compare(node: CompareNode, ctx: Ctx): Promise<boolean> {
  const any = isAnyOp(node.op);
  const left = await valuesOf(node.left, ctx, any);
  const right = await valuesOf(node.right, ctx, any);
  const ls = left.values.length === 0 ? [null] : left.values;
  const rs = right.values.length === 0 ? [null] : right.values;
  if (any || left.any === true || right.any === true) {
    return ls.some((l) => rs.some((r) => compareValues(node.op, l, r)));
  }
  if (left.multi || right.multi)
    return ls.every((l) => rs.every((r) => compareValues(node.op, l, r)));
  return compareValues(node.op, ls[0], rs[0]);
}

async function valuesOf(operand: Operand, ctx: Ctx, anyOp: boolean): Promise<Values> {
  switch (operand.kind) {
    case 'literal':
      return single(operand.value);
    case 'macro': {
      const value = macroValue(operand.name, ctx.input.nowMs);
      return value === undefined ? fail(operand, `unknown macro ${operand.name}`) : single(value);
    }
    case 'call':
      return call(operand, ctx, anyOp);
    case 'ident':
      return modified(operand, await identValues(operand, ctx, anyOp), ctx);
  }
}

async function call(
  node: Extract<Operand, { kind: 'call' }>,
  ctx: Ctx,
  anyOp: boolean,
): Promise<Values> {
  const args = await Promise.all(node.args.map((a) => valuesOf(a, ctx, anyOp)));
  if (node.name === 'geoDistance') {
    if (args.length !== 4) return fail(node, 'geoDistance takes 4 arguments');
    const out: number[] = [];
    for (const combo of product(args.map((a) => a.values.map(Number)))) {
      const [lonA = NaN, latA = NaN, lonB = NaN, latB = NaN] = combo;
      if ([lonA, latA, lonB, latB].every(Number.isFinite))
        out.push(geoDistance(lonA, latA, lonB, latB));
    }
    return { values: out, multi: false, any: true };
  }
  if (node.name === 'strftime') {
    const [format, time, ...mods] = args;
    if (format === undefined || time === undefined)
      return fail(node, 'strftime takes a format and a time');
    const modifiers = mods.map((m) => text(m.values[0]));
    const pattern = text(format.values[0]);
    return { values: time.values.map((t) => strftime(pattern, t, modifiers)), multi: time.multi };
  }
  return fail(node, `unknown function ${node.name}`);
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function* product(lists: readonly (readonly number[])[]): Generator<number[]> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [head = [], ...rest] = lists;
  for (const x of head) for (const tail of product(rest)) yield [x, ...tail];
}

async function identValues(node: IdentNode, ctx: Ctx, anyOp: boolean): Promise<Values> {
  const { input } = ctx;
  const root = node.root;
  if (root.kind === 'record') {
    return walk(
      input.record === null ? [] : [input.record],
      input.collection,
      node.path,
      node,
      ctx,
    );
  }
  if (root.kind === 'collection') {
    if (!anyOp) {
      const rows = ctx.allRows.get(root.alias) ?? [];
      const values = await walk(rows, root.collection, node.path, node, ctx);
      return { values: values.values, multi: true };
    }
    const row = ctx.binding.get(root.alias) ?? null;
    return walk(row === null ? [] : [row], root.collection, node.path, node, ctx);
  }
  return requestValues(node, ctx);
}

async function requestValues(node: IdentNode, ctx: Ctx): Promise<Values> {
  const { request, collection } = ctx.input;
  const [section = '', ...rest] = node.path;
  switch (section) {
    case 'method':
    case 'context':
      if (rest.length > 0) return fail(node, `@request.${section} has no fields`);
      return single(section === 'method' ? request.method : request.context);
    case 'query':
    case 'headers': {
      const map = section === 'query' ? request.query : request.headers;
      if (rest.length !== 1) return fail(node, `expected @request.${section}.<name>`);
      return single(map[rest[0] ?? '']);
    }
    case 'auth': {
      if (rest.length === 0) return fail(node, 'expected @request.auth.<field>');
      const auth = request.auth;
      const authCollection =
        typeof auth?.['collectionName'] === 'string' ? auth['collectionName'] : '';
      return walk(auth === null ? [] : [auth], authCollection, rest, node, ctx);
    }
    case 'body': {
      const [name = '', ...deeper] = rest;
      if (name === '') return fail(node, 'expected @request.body.<field>');
      const value = request.body[name];
      if (deeper.length === 0)
        return listOf(value, fieldOf(ctx.input.schema, collection, name)?.multi === true);
      const field = fieldOf(ctx.input.schema, collection, name);
      if (field?.kind !== 'relation' || field.collection === undefined) {
        return fail(node, `@request.body.${name} is not a relation`);
      }
      const records = await ctx.input.resolver.byIds(field.collection, idsOf(value));
      const inner = await walk(records, field.collection, deeper, node, ctx);
      return { values: inner.values, multi: inner.multi || field.multi };
    }
    default:
      return fail(node, `unknown @request.${section}`);
  }
}

function listOf(value: unknown, multi: boolean): Values {
  if (Array.isArray(value)) return { values: value, multi: true };
  return { values: value === undefined ? [] : [value], multi };
}

function idsOf(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === 'string' && v !== '');
  return typeof value === 'string' && value !== '' ? [value] : [];
}

/** Follows a field path from some records through relations and into JSON values. */
async function walk(
  start: readonly RecordData[],
  collection: string,
  path: readonly string[],
  node: IdentNode,
  ctx: Ctx,
): Promise<Values> {
  let records = start;
  let current = collection;
  let multi = start.length > 1;
  for (let i = 0; i < path.length; i++) {
    const name = path[i] ?? '';
    const field = fieldOf(ctx.input.schema, current, name);
    const last = i === path.length - 1;
    if (field !== undefined && isObjectKind(field.kind) && !last) {
      const values = records.map((r) => dig(r[name], path.slice(i + 1)));
      return { values, multi: multi || field.multi };
    }
    if (last) {
      const values = records.flatMap((r) =>
        Array.isArray(r[name]) ? (r[name] as unknown[]) : [r[name] ?? null],
      );
      return { values, multi: multi || field?.multi === true };
    }
    if (field?.kind !== 'relation' || field.collection === undefined) {
      return fail(node, `${name} is not a relation field of ${current}`);
    }
    if (i >= MAX_HOPS) return fail(node, `more than ${String(MAX_HOPS)} relation hops`);
    multi ||= field.multi;
    records = await ctx.input.resolver.byIds(
      field.collection,
      records.flatMap((r) => idsOf(r[name])),
    );
    current = field.collection;
  }
  return { values: [], multi };
}

function dig(value: unknown, path: readonly string[]): unknown {
  let v = value;
  for (const key of path) {
    if (v === null || typeof v !== 'object') return null;
    v = (v as Record<string, unknown>)[key];
  }
  return v ?? null;
}

function modified(node: IdentNode, values: Values, ctx: Ctx): Values {
  if (node.modifier === undefined) return values;
  switch (node.modifier) {
    case 'length':
      return single(values.values.filter((v) => v !== null && v !== '').length);
    case 'each':
      return { values: values.values, multi: true };
    case 'lower':
      return {
        ...values,
        values: values.values.map((v) => (typeof v === 'string' ? v.toLowerCase() : v)),
      };
    case 'isset':
    case 'changed':
      return single(presence(node, ctx));
  }
}

function presence(node: IdentNode, ctx: Ctx): boolean {
  const [section = '', name = ''] = node.path;
  const { request, record } = ctx.input;
  if (
    node.root.kind !== 'request' ||
    !['body', 'query', 'headers'].includes(section) ||
    node.path.length !== 2
  ) {
    return fail(
      node,
      `:${node.modifier ?? ''} works on @request.body, query and headers fields only`,
    );
  }
  const map: Readonly<Record<string, unknown>> =
    section === 'body' ? request.body : section === 'query' ? request.query : request.headers;
  const isset = Object.hasOwn(map, name);
  if (node.modifier === 'isset') return isset;
  if (section !== 'body') return fail(node, ':changed works on @request.body fields only');
  return isset && JSON.stringify(map[name] ?? null) !== JSON.stringify(record?.[name] ?? null);
}

interface AliasScope {
  readonly bindings: Iterable<ReadonlyMap<string, RecordData | null>>;
  readonly allRows: ReadonlyMap<string, readonly RecordData[]>;
}

/** Candidate rows per `@collection` alias, narrowed by the top-level `?=` conjuncts. */
async function bindAliases(expr: Expr, input: EvalInput): Promise<AliasScope> {
  const aliases = new Map<string, { collection: string; span: Span; plain: boolean }>();
  for (const cmp of comparisons(expr)) {
    for (const ident of [...identsOf(cmp.left), ...identsOf(cmp.right)]) {
      if (ident.root.kind !== 'collection') continue;
      const seen = aliases.get(ident.root.alias);
      if (seen !== undefined && seen.collection !== ident.root.collection) {
        fail(ident, `alias ${ident.root.alias} names two collections`);
      }
      const plain = (seen?.plain ?? false) || !isAnyOp(cmp.op);
      aliases.set(ident.root.alias, { collection: ident.root.collection, span: ident, plain });
    }
  }
  if (aliases.size === 0) return { bindings: [new Map()], allRows: new Map() };
  const hints = await aliasHints(expr, input);
  const names: string[] = [];
  const rowLists: (RecordData | null)[][] = [];
  const allRows = new Map<string, readonly RecordData[]>();
  let combos = 1;
  for (const [alias, { collection, span, plain }] of aliases) {
    const rows = await input.resolver.rows(collection, hints.get(alias) ?? [], MAX_ALIAS_ROWS + 1);
    if (rows.length > MAX_ALIAS_ROWS) {
      fail(
        span,
        `@collection.${collection} matches over ${String(MAX_ALIAS_ROWS)} rows; narrow it with ?= on a field`,
      );
    }
    if (plain) {
      const every = await input.resolver.rows(collection, [], MAX_ALIAS_ROWS + 1);
      if (every.length > MAX_ALIAS_ROWS)
        fail(span, `@collection.${collection} has over ${String(MAX_ALIAS_ROWS)} rows`);
      allRows.set(alias, every);
    }
    names.push(alias);
    rowLists.push(rows.length === 0 ? [null] : rows);
    combos *= rowLists[rowLists.length - 1]?.length ?? 1;
  }
  if (combos > MAX_BINDINGS)
    fail(expr, `@collection joins give over ${String(MAX_BINDINGS)} row combinations`);
  return { bindings: bindingsOf(names, rowLists), allRows };
}

function* bindingsOf(
  names: readonly string[],
  lists: readonly (readonly (RecordData | null)[])[],
): Generator<ReadonlyMap<string, RecordData | null>> {
  const index = names.map(() => 0);
  for (;;) {
    yield new Map(names.map((n, i) => [n, lists[i]?.[index[i] ?? 0] ?? null]));
    let k = names.length - 1;
    while (k >= 0 && (index[k] ?? 0) + 1 >= (lists[k]?.length ?? 1)) index[k--] = 0;
    if (k < 0) return;
    index[k] = (index[k] ?? 0) + 1;
  }
}

/** `@collection.a.f ?= v` conjuncts with `v` independent of the alias rows. */
async function aliasHints(expr: Expr, input: EvalInput): Promise<Map<string, RowHint[]>> {
  const hints = new Map<string, RowHint[]>();
  for (const c of conjuncts(expr)) {
    if (c.kind !== 'compare' || c.op !== '?=') continue;
    for (const [side, other] of [
      [c.left, c.right],
      [c.right, c.left],
    ] as const) {
      if (side.kind !== 'ident' || side.root.kind !== 'collection') continue;
      if (side.path.length !== 1 || side.modifier !== undefined) continue;
      if (identsOf(other).some((i) => i.root.kind === 'collection')) continue;
      const values = await operandValues(other, input);
      if (
        !values.ok ||
        values.value.length === 0 ||
        values.value.some((v) => v === null || v === '')
      )
        continue;
      const list = hints.get(side.root.alias) ?? [];
      list.push({ field: side.path[0] ?? '', values: values.value });
      hints.set(side.root.alias, list);
    }
  }
  return hints;
}
