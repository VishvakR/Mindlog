import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { Identity } from '@mindlog/auth';
import { principalOf } from '@mindlog/auth';
import type { CollectionSchema } from '@mindlog/collections';
import { indexesOf, isMulti, storedFields } from '@mindlog/collections';
import type {
  EvalInput,
  Expr,
  IndexInfo,
  RecordData,
  RecordResolver,
  RequestInfo,
  RowHint,
  ScanPlan,
  SchemaView,
} from '@mindlog/rules';
import { ParseCache, checkRule, evaluateRule, formatDate, planScan } from '@mindlog/rules';
import type { Caller } from '../kv/range-router.js';
import type {
  CollectionRanges,
  RawRecord,
  ScanPage,
  StoredCollection,
} from './collection-ranges.js';

/** Who asks and how (PocketBase `@request`), for one request. */
export interface RequestContext {
  readonly identity: Identity;
  readonly tenant: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: string;
  /** `default`, `realtime`, `protectedFile`, `password`, `otp`, `oauth2`. */
  readonly context?: string;
}

/** A record as the API returns it (PocketBase shape). */
export type RecordView = Record<string, unknown>;

export const parseCache = new ParseCache();
/** Rows a list may read before it must use an index (PLAN 5 "bounded everything"). */
export const MAX_SCAN = 10_000;
const PAGE_ROWS = 500;
const MAX_EXPAND_DEPTH = 6;

export const callerOf = (ctx: RequestContext): Caller => ({
  tenant: ctx.tenant,
  principal: principalOf(ctx.identity),
});
export const isSuperuser = (ctx: RequestContext): boolean => ctx.identity.kind === 'superuser';

/** The record as rules see it: every field, hidden ones too, plus the system fields. */
export function ruleRecord(collection: string, r: RawRecord): RecordData {
  return {
    ...r.data,
    id: r.id,
    collectionName: collection,
    created: formatDate(r.createdMs),
    updated: formatDate(r.updatedMs),
  };
}

export function indexInfos(schema: CollectionSchema): IndexInfo[] {
  const fields = storedFields(schema);
  const kindOf = (name: string) =>
    name === 'id'
      ? 'text'
      : name === 'created' || name === 'updated'
        ? 'autodate'
        : fields.find((f) => f.name === name)?.type;
  return indexesOf(schema).flatMap((index) => {
    const out = index.fields.map((name) => ({ name, kind: kindOf(name) }));
    const single = index.fields.every((n) => {
      const f = fields.find((x) => x.name === n);
      return f === undefined || !isMulti(f);
    });
    return single && out.every((f) => f.kind !== undefined)
      ? [{ name: index.name, fields: out as IndexInfo['fields'] }]
      : [];
  });
}

export function parse(source: string): Result<Expr, MindlogError> {
  const parsed = parseCache.parse(source);
  return parsed.ok
    ? parsed
    : err(
        mindlogError(
          'INVALID_ARGUMENT',
          `invalid filter at ${String(parsed.error.from)}: ${parsed.error.message}`,
        ),
      );
}

/**
 * Reads for one request: resolves relations and `@collection` rows for rules,
 * evaluates rules as the requester, expands relations and shapes records.
 */
export class RecordReader {
  readonly #records = new Map<string, Promise<RawRecord | undefined>>();
  #auth: Promise<RecordData | null> | undefined;

  constructor(
    readonly ctx: RequestContext,
    readonly catalog: ReadonlyMap<string, StoredCollection>,
    readonly schemas: SchemaView,
    private readonly ranges: CollectionRanges,
    private readonly nowMs: () => number,
  ) {}

  get caller(): Caller {
    return callerOf(this.ctx);
  }

  schema(name: string): Result<CollectionSchema, MindlogError> {
    const c = this.catalog.get(name);
    return c ? ok(c.schema) : err(mindlogError('NOT_FOUND', `Missing collection ${name}.`));
  }

  async get(
    collection: string,
    ids: readonly string[],
  ): Promise<Result<RawRecord[], MindlogError>> {
    const missing = ids.filter((id) => !this.#records.has(`${collection}/${id}`));
    if (missing.length > 0) {
      const fetched = this.ranges.run<RawRecord[]>(this.caller, collection, {
        op: 'get',
        collection,
        ids: missing,
      });
      for (const id of missing) {
        this.#records.set(
          `${collection}/${id}`,
          fetched.then((r) => (r.ok ? r.value.find((x) => x.id === id) : undefined)),
        );
      }
      const done = await fetched;
      if (!done.ok) return done;
    }
    const out: RawRecord[] = [];
    for (const id of ids) {
      const r = await this.#records.get(`${collection}/${id}`);
      if (r) out.push(r);
    }
    return ok(out);
  }

  /** The `@request.auth` record, or null. */
  authRecord(): Promise<RecordData | null> {
    this.#auth ??= (async () => {
      const id = this.ctx.identity;
      if (id.kind !== 'record' && id.kind !== 'delegated') return null;
      const found = await this.get(id.collection, [id.id]);
      const r = found.ok ? found.value[0] : undefined;
      return r ? ruleRecord(id.collection, r) : null;
    })();
    return this.#auth;
  }

  async request(body: Readonly<Record<string, unknown>> = {}): Promise<RequestInfo> {
    return {
      auth: await this.authRecord(),
      body,
      query: this.ctx.query ?? {},
      headers: this.ctx.headers ?? {},
      method: this.ctx.method ?? 'GET',
      context: this.ctx.context ?? 'default',
    };
  }

  readonly resolver: RecordResolver = {
    byIds: async (collection, ids) => {
      const found = await this.get(collection, ids);
      return found.ok ? found.value.map((r) => ruleRecord(collection, r)) : [];
    },
    rows: async (collection, hints, limit) => {
      const schema = this.catalog.get(collection)?.schema;
      if (!schema) return [];
      const plan = hintPlan(schema, hints);
      const out: RecordData[] = [];
      for await (const page of this.#pages(collection, plan)) {
        if (!page.ok) return out;
        for (const r of page.value.records) out.push(ruleRecord(collection, r));
        if (out.length >= limit) return out.slice(0, limit);
      }
      return out;
    },
  };

  async input(
    collection: string,
    record: RecordData | null,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<EvalInput> {
    return {
      collection,
      record,
      request: await this.request(body),
      nowMs: this.nowMs(),
      schema: this.schemas,
      resolver: this.resolver,
    };
  }

  /** Evaluates a parsed rule for one record. */
  async holds(expr: Expr, input: EvalInput): Promise<Result<boolean, MindlogError>> {
    const result = await evaluateRule(expr, input);
    return result.ok
      ? result
      : err(mindlogError('INVALID_ARGUMENT', `rule cannot be evaluated: ${result.error.message}`));
  }

  /**
   * Whether the requester passes a rule slot (superusers always do). `null`
   * rules are `PERMISSION_DENIED`; a failed rule is `false`.
   */
  async allows(
    rule: string | null,
    collection: string,
    record: RecordData | null,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<Result<boolean, MindlogError>> {
    if (isSuperuser(this.ctx)) return ok(true);
    if (rule === null)
      return err(mindlogError('PERMISSION_DENIED', 'Only superusers can perform this action.'));
    if (rule === '') return ok(true);
    const expr = parse(rule);
    if (!expr.ok) return expr;
    return this.holds(expr.value, await this.input(collection, record, body));
  }

  /** Candidate pages for a plan, up to `MAX_SCAN` rows. */
  async *#pages(
    collection: string,
    plan: ScanPlan,
  ): AsyncGenerator<Result<ScanPage, MindlogError>> {
    let after: string | undefined;
    let rows = 0;
    do {
      const page = await this.ranges.run<ScanPage>(this.caller, collection, {
        op: 'scan',
        collection,
        plan,
        limit: PAGE_ROWS,
        ...(after === undefined ? {} : { after }),
      });
      yield page;
      if (!page.ok) return;
      rows += page.value.records.length;
      after = page.value.next;
      if (rows >= MAX_SCAN && after !== undefined) {
        yield err(
          mindlogError(
            'INVALID_ARGUMENT',
            `the request reads over ${String(MAX_SCAN)} records; filter on an indexed field`,
          ),
        );
        return;
      }
    } while (after !== undefined);
  }

  /** Records matching `expr` (or all), read through the best index. `stopAt` ends early. */
  async matching(
    collection: string,
    expr: Expr | undefined,
    stopAt = Infinity,
  ): Promise<Result<RawRecord[], MindlogError>> {
    const schema = this.schema(collection);
    if (!schema.ok) return schema;
    const input = await this.input(collection, null);
    const plan = await planScan(expr, indexInfos(schema.value), input);
    const out: RawRecord[] = [];
    for await (const page of this.#pages(collection, plan)) {
      if (!page.ok) return page;
      for (const r of page.value.records) {
        if (expr !== undefined) {
          const held = await this.holds(expr, { ...input, record: ruleRecord(collection, r) });
          if (!held.ok) return held;
          if (!held.value) continue;
        }
        out.push(r);
        if (out.length >= stopAt) return ok(out);
      }
    }
    return ok(out);
  }

  /** The record as the requester may see it: hidden fields dropped, and email unless visible or theirs. */
  present(collection: string, r: RawRecord): RecordView {
    const schema = this.catalog.get(collection)?.schema;
    const view: RecordView = {
      collectionName: collection,
      id: r.id,
      created: formatDate(r.createdMs),
      updated: formatDate(r.updatedMs),
    };
    const superuser = isSuperuser(this.ctx);
    const me = this.ctx.identity;
    const own =
      (me.kind === 'record' || me.kind === 'delegated') &&
      me.collection === collection &&
      me.id === r.id;
    for (const f of schema ? storedFields(schema) : []) {
      if (f.hidden && !superuser) continue;
      if (
        schema?.type === 'auth' &&
        f.name === 'email' &&
        !superuser &&
        !own &&
        r.data['emailVisibility'] !== true
      )
        continue;
      view[f.name] = r.data[f.name];
    }
    return view;
  }

  /** Adds `expand` for the requested relation paths (`author,author.teams`), checking each `viewRule`. */
  async expand(
    collection: string,
    views: RecordView[],
    records: RawRecord[],
    spec: string,
    depth = 0,
  ): Promise<void> {
    const tree = expandTree(spec);
    if (tree.size === 0 || depth >= MAX_EXPAND_DEPTH) return;
    const schema = this.catalog.get(collection)?.schema;
    for (const [name, rest] of tree) {
      const field = schema ? storedFields(schema).find((f) => f.name === name) : undefined;
      if (field?.type !== 'relation') continue;
      const target = this.catalog.get(field.collection)?.schema;
      if (!target) continue;
      const idsOf = (r: RawRecord): string[] => {
        const v = r.data[name];
        return Array.isArray(v)
          ? v.filter((x): x is string => typeof x === 'string')
          : typeof v === 'string' && v !== ''
            ? [v]
            : [];
      };
      const all = [...new Set(records.flatMap(idsOf))];
      const found = await this.get(field.collection, all);
      if (!found.ok) continue;
      const visible = new Map<string, { raw: RawRecord; view: RecordView }>();
      for (const r of found.value) {
        const allowed = await this.allows(
          target.viewRule,
          field.collection,
          ruleRecord(field.collection, r),
        );
        if (allowed.ok && allowed.value)
          visible.set(r.id, { raw: r, view: this.present(field.collection, r) });
      }
      const nested = [...visible.values()];
      await this.expand(
        field.collection,
        nested.map((n) => n.view),
        nested.map((n) => n.raw),
        rest,
        depth + 1,
      );
      records.forEach((r, i) => {
        const ids = idsOf(r).filter((id) => visible.has(id));
        if (ids.length === 0) return;
        const view = views[i];
        if (!view) return;
        const expanded = (view['expand'] as Record<string, unknown> | undefined) ?? {};
        expanded[name] = isMulti(field)
          ? ids.map((id) => visible.get(id)?.view)
          : visible.get(ids[0] ?? '')?.view;
        view['expand'] = expanded;
      });
    }
  }

  /** Checks a client filter: hidden fields only for superusers. */
  checkFilter(collection: string, expr: Expr): Result<void, MindlogError> {
    const issues = checkRule(expr, {
      collection,
      schema: this.schemas,
      allowHidden: isSuperuser(this.ctx),
    });
    const first = issues[0];
    return first
      ? err(
          mindlogError(
            'INVALID_ARGUMENT',
            `invalid filter at ${String(first.from)}: ${first.message}`,
          ),
        )
      : ok(undefined);
  }
}

/** `a,a.b,c` → {a: 'b', c: ''} (the rest of each path, comma-joined). */
function expandTree(spec: string): Map<string, string> {
  const tree = new Map<string, string[]>();
  for (const path of spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')) {
    const [head = '', ...rest] = path.split('.');
    const list = tree.get(head) ?? [];
    if (rest.length > 0) list.push(rest.join('.'));
    tree.set(head, list);
  }
  return new Map([...tree].map(([k, v]) => [k, v.join(',')]));
}

/** An index or id lookup for `@collection` hints, else a scan. */
function hintPlan(schema: CollectionSchema, hints: readonly RowHint[]): ScanPlan {
  const byId = hints.find((h) => h.field === 'id');
  if (byId) return { kind: 'ids', ids: byId.values.map(String) };
  for (const index of indexInfos(schema)) {
    const first = index.fields[0];
    const hint = hints.find((h) => h.field === first?.name && h.values.length === 1);
    const value = hint?.values[0];
    if (
      first &&
      hint &&
      (first.kind === 'number' ? typeof value === 'number' : typeof value === 'string')
    ) {
      return { kind: 'index', index: index.name, eq: [value] };
    }
  }
  return { kind: 'scan' };
}
