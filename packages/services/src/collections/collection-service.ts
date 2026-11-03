import { create, toBinary } from '@bufbuild/protobuf';
import { randomBytes } from 'node:crypto';
import type { Clock, MindlogError, Result } from '@mindlog/core';
import { err, isUserTenant, mindlogError, ok } from '@mindlog/core';
import type { CollectionInput, CollectionSchema } from '@mindlog/collections';
import { NAME, checkSchema, parseSchema, schemaView, storedFields } from '@mindlog/collections';
import { SchemaChangeSchema } from '@mindlog/proto';
import type { Completions, Expr, RuleIssue } from '@mindlog/rules';
import { checkRule, completeRule, compareValues } from '@mindlog/rules';
import type { CommandStamper } from '@mindlog/statemachine';
import { replies } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { Caller, RangeCall, RangeRouter } from '../kv/range-router.js';
import { Catalog } from './catalog.js';
import { CollectionRanges } from './collection-ranges.js';
import type { ProposeOutcome, RawRecord, StoredCollection } from './collection-ranges.js';
import type { RecordView, RequestContext } from './record-reader.js';
import { RecordReader, callerOf, isSuperuser, parse, ruleRecord } from './record-reader.js';
import type { Body, TextEmbedder, WriteExtras, WriteResult } from './record-writer.js';
import { RecordWriter } from './record-writer.js';

/** Collection commands need every node on binary version 9 (ADR-0034). */
export const COLLECTIONS_CLUSTER_VERSION = 9;

export interface CollectionServiceDeps {
  readonly router: RangeRouter;
  readonly stamper: CommandStamper;
  readonly clock: Clock;
  /** The cluster version PD reports; writes need `COLLECTIONS_CLUSTER_VERSION`. Absent: always met. */
  readonly clusterVersion?: () => number;
  /** Fills `vector` fields; without it they stay empty. */
  readonly embedder?: TextEmbedder;
  /** Tenants with full-stack mode on (PLAN 16: enabled per tenant). Absent: every user tenant. */
  readonly enabled?: (tenant: string) => boolean;
}

export interface ListQuery {
  readonly page?: number;
  readonly perPage?: number;
  readonly filter?: string;
  readonly sort?: string;
  readonly expand?: string;
  readonly fields?: string;
  readonly skipTotal?: boolean;
}

export interface ListResult {
  readonly page: number;
  readonly perPage: number;
  /** -1 with `skipTotal`. */
  readonly totalItems: number;
  readonly totalPages: number;
  readonly items: RecordView[];
}

export interface CollectionInfo {
  readonly schema: CollectionSchema;
  readonly version: string;
}

const MAX_PER_PAGE = 500;
const forbidden = () =>
  err(mindlogError('PERMISSION_DENIED', 'Only superusers can perform this action.'));

/**
 * The full-stack collections API (PLAN 16): schema administration for
 * superusers, and record CRUD for everyone else under the collection rules,
 * with PocketBase's status conventions (ADR-0018).
 */
export class CollectionService {
  readonly ranges: CollectionRanges;
  readonly catalog: Catalog;

  constructor(private readonly d: CollectionServiceDeps) {
    this.ranges = new CollectionRanges({ router: d.router, stamper: d.stamper });
    this.catalog = new Catalog({ ranges: this.ranges, clock: d.clock });
  }

  #now = (): number => Number(this.d.clock.now());

  #available(ctx: RequestContext, write: boolean): Result<void, MindlogError> {
    if (!isUserTenant(ctx.tenant) || (this.d.enabled && !this.d.enabled(ctx.tenant))) {
      return err(
        mindlogError('INVALID_ARGUMENT', `collections are not enabled for tenant ${ctx.tenant}`),
      );
    }
    if (write && this.d.clusterVersion && this.d.clusterVersion() < COLLECTIONS_CLUSTER_VERSION) {
      return err(
        mindlogError(
          'UNAVAILABLE',
          'the cluster has not reached the version of collection commands yet; retry',
        ),
      );
    }
    return ok(undefined);
  }

  /** A reader for one request, over the current schemas. */
  async reader(ctx: RequestContext): Promise<Result<RecordReader, MindlogError>> {
    const all = await this.catalog.all(callerOf(ctx));
    if (!all.ok) return all;
    const schemas = new Map([...all.value].map(([n, c]) => [n, c.schema]));
    return ok(new RecordReader(ctx, all.value, schemaView(schemas), this.ranges, this.#now));
  }

  async #writer(ctx: RequestContext): Promise<Result<RecordWriter, MindlogError>> {
    const available = this.#available(ctx, true);
    if (!available.ok) return available;
    const reader = await this.reader(ctx);
    if (!reader.ok) return reader;
    return ok(
      new RecordWriter(reader.value, {
        ranges: this.ranges,
        nowMs: this.#now,
        ...(this.d.embedder ? { embedder: this.d.embedder } : {}),
      }),
    );
  }

  // ---- schemas (superusers) ----

  async listCollections(ctx: RequestContext): Promise<Result<CollectionInfo[], MindlogError>> {
    if (!isSuperuser(ctx)) return forbidden();
    const available = this.#available(ctx, false);
    if (!available.ok) return available;
    const all = await this.catalog.all(callerOf(ctx));
    if (!all.ok) return all;
    return ok([...all.value.values()].sort((a, b) => a.schema.name.localeCompare(b.schema.name)));
  }

  async getCollection(
    ctx: RequestContext,
    name: string,
  ): Promise<Result<CollectionInfo, MindlogError>> {
    if (!isSuperuser(ctx)) return forbidden();
    const found = await this.#fresh(callerOf(ctx), name);
    if (!found.ok) return found;
    return found.value
      ? ok(found.value)
      : err(mindlogError('NOT_FOUND', `Missing collection ${name}.`));
  }

  async #fresh(
    caller: Caller,
    name: string,
  ): Promise<Result<StoredCollection | null, MindlogError>> {
    if (!NAME.test(name)) return err(mindlogError('NOT_FOUND', `Missing collection ${name}.`));
    return this.ranges.run<StoredCollection | null>(caller, name, {
      op: 'schema',
      collection: name,
    });
  }

  /** Creates (no `expectVersion`) or replaces a collection, after checking its rules and relations. */
  async saveCollection(
    ctx: RequestContext,
    input: CollectionInput,
    expectVersion?: string,
  ): Promise<Result<CollectionInfo, MindlogError>> {
    if (!isSuperuser(ctx)) return forbidden();
    const available = this.#available(ctx, true);
    if (!available.ok) return available;
    const parsed = parseSchema(input);
    const schema = parsed.ok ? checkSchema(parsed.value) : parsed;
    if (!schema.ok) return schema;
    const caller = callerOf(ctx);
    const all = await this.catalog.all(caller);
    if (!all.ok) return all;
    const problems = this.#problems(schema.value, all.value);
    if (Object.keys(problems).length > 0) {
      return err(
        mindlogError('INVALID_ARGUMENT', 'invalid collection schema', { fields: problems }),
      );
    }
    const current = await this.#fresh(caller, schema.value.name);
    if (!current.ok) return current;
    const version = expectVersion ?? (current.value ? undefined : '0');
    if (version === undefined)
      return err(mindlogError('ALREADY_EXISTS', `collection ${schema.value.name} exists`));
    const change = create(SchemaChangeSchema, {
      collection: schema.value.name,
      schema: new TextEncoder().encode(JSON.stringify(schema.value)),
      expectVersion: BigInt(version),
    });
    const out = await this.#proposeSchema(caller, schema.value.name, change);
    if (!out.ok) return out;
    return ok({ schema: schema.value, version: out.value.versions[0] ?? '0' });
  }

  async deleteCollection(ctx: RequestContext, name: string): Promise<Result<void, MindlogError>> {
    if (!isSuperuser(ctx)) return forbidden();
    const available = this.#available(ctx, true);
    if (!available.ok) return available;
    const caller = callerOf(ctx);
    const current = await this.#fresh(caller, name);
    if (!current.ok) return current;
    if (!current.value) return err(mindlogError('NOT_FOUND', `Missing collection ${name}.`));
    const all = await this.catalog.all(caller);
    if (!all.ok) return all;
    const users = [...all.value.values()].filter(
      (c) =>
        c.schema.name !== name &&
        storedFields(c.schema).some((f) => f.type === 'relation' && f.collection === name),
    );
    if (users.length > 0) {
      return err(
        mindlogError(
          'INVALID_ARGUMENT',
          `collection ${name} is referenced by ${users.map((u) => u.schema.name).join(', ')}`,
        ),
      );
    }
    const change = create(SchemaChangeSchema, {
      collection: name,
      schema: new Uint8Array(),
      expectVersion: BigInt(current.value.version),
    });
    const out = await this.#proposeSchema(caller, name, change);
    return out.ok ? ok(undefined) : out;
  }

  async #proposeSchema(
    caller: Caller,
    name: string,
    change: ReturnType<typeof create<typeof SchemaChangeSchema>>,
  ) {
    const out = await this.ranges.run<ProposeOutcome>(
      caller,
      name,
      {
        op: 'propose',
        body: 'schemaChange',
        bytes: Buffer.from(toBinary(SchemaChangeSchema, change)).toString('base64'),
        actor: '',
      },
      randomBytes(16),
    );
    this.catalog.invalidate(caller.tenant);
    return out;
  }

  /** Rules that do not parse or check, and relations to collections that do not exist. */
  #problems(
    schema: CollectionSchema,
    all: ReadonlyMap<string, StoredCollection>,
  ): Record<string, string> {
    const schemas = new Map([...all].map(([n, c]) => [n, c.schema]));
    schemas.set(schema.name, schema);
    const view = schemaView(schemas);
    const problems: Record<string, string> = {};
    for (const slot of [
      'listRule',
      'viewRule',
      'createRule',
      'updateRule',
      'deleteRule',
      'manageRule',
    ] as const) {
      const rule = schema[slot];
      if (rule === null || rule === '') continue;
      const issue = ruleIssues(rule, schema.name, view)[0];
      if (issue) problems[slot] = `${issue.message} (at ${String(issue.from)})`;
    }
    for (const [i, f] of schema.fields.entries()) {
      if (f.type === 'relation' && !schemas.has(f.collection))
        problems[`fields.${String(i)}.collection`] = `no collection ${f.collection}`;
    }
    if (schema.view && !schemas.has(schema.view.from))
      problems['view.from'] = `no collection ${schema.view.from}`;
    return problems;
  }

  /** Live validation and completion for the dashboard's rule editor. */
  async checkRuleText(
    ctx: RequestContext,
    input: { collection: string; rule: string; cursor?: number; draft?: CollectionInput },
  ): Promise<Result<{ issues: RuleIssue[]; completions?: Completions }, MindlogError>> {
    if (!isSuperuser(ctx)) return forbidden();
    const all = await this.catalog.all(callerOf(ctx));
    if (!all.ok) return all;
    const schemas = new Map([...all.value].map(([n, c]) => [n, c.schema]));
    const draft = input.draft ? parseSchema(input.draft) : undefined;
    if (draft?.ok) schemas.set(draft.value.name, draft.value);
    const view = schemaView(schemas);
    const issues = input.rule.trim() === '' ? [] : ruleIssues(input.rule, input.collection, view);
    const completions =
      input.cursor === undefined
        ? undefined
        : completeRule(input.rule, input.cursor, input.collection, view);
    return ok(completions ? { issues, completions } : { issues });
  }

  // ---- records ----

  async list(
    ctx: RequestContext,
    collection: string,
    q: ListQuery = {},
  ): Promise<Result<ListResult, MindlogError>> {
    const available = this.#available(ctx, false);
    if (!available.ok) return available;
    const reader = await this.reader(ctx);
    if (!reader.ok) return reader;
    const r = reader.value;
    const schema = r.schema(collection);
    if (!schema.ok) return schema;
    const parts: Expr[] = [];
    if (!isSuperuser(ctx)) {
      if (schema.value.listRule === null) return forbidden();
      if (schema.value.listRule !== '') {
        const rule = parse(schema.value.listRule);
        if (!rule.ok) return rule;
        parts.push(rule.value);
      }
    }
    if (q.filter !== undefined && q.filter.trim() !== '') {
      const filter = parse(q.filter);
      if (!filter.ok) return filter;
      const checked = r.checkFilter(collection, filter.value);
      if (!checked.ok) return checked;
      parts.push(filter.value);
    }
    const expr = parts.reduce<Expr | undefined>(
      (a, b) => (a === undefined ? b : { kind: 'and', left: a, right: b, from: 0, to: 0 }),
      undefined,
    );
    const page = Math.max(1, Math.floor(q.page ?? 1));
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.floor(q.perPage ?? 30)));
    const sorter = sortOf(q.sort, schema.value, isSuperuser(ctx));
    if (!sorter.ok) return sorter;
    const early = q.skipTotal === true && sorter.value === undefined;
    const found = await r.matching(collection, expr, early ? page * perPage : Infinity);
    if (!found.ok) return found;
    const rows = sorter.value ? sortRows(collection, found.value, sorter.value) : found.value;
    const slice = rows.slice((page - 1) * perPage, page * perPage);
    const items = await this.#shape(r, collection, slice, q);
    const total = early ? -1 : rows.length;
    return ok({
      page,
      perPage,
      totalItems: total,
      totalPages: early ? -1 : Math.ceil(total / perPage),
      items,
    });
  }

  async view(
    ctx: RequestContext,
    collection: string,
    id: string,
    q: Pick<ListQuery, 'expand' | 'fields'> = {},
  ): Promise<Result<RecordView, MindlogError>> {
    const available = this.#available(ctx, false);
    if (!available.ok) return available;
    const reader = await this.reader(ctx);
    if (!reader.ok) return reader;
    const visible = await this.visible(reader.value, collection, id);
    if (!visible.ok) return visible;
    const [shaped] = await this.#shape(reader.value, collection, [visible.value], q);
    return shaped
      ? ok(shaped)
      : err(mindlogError('NOT_FOUND', "The requested resource wasn't found."));
  }

  /** The raw record if the reader passes its `viewRule`, else `NOT_FOUND` (403 for a locked rule). */
  async visible(
    r: RecordReader,
    collection: string,
    id: string,
  ): Promise<Result<RawRecord, MindlogError>> {
    const schema = r.schema(collection);
    if (!schema.ok) return schema;
    if (schema.value.viewRule === null && !isSuperuser(r.ctx)) return forbidden();
    const found = await r.get(collection, [id]);
    if (!found.ok) return found;
    const record = found.value[0];
    if (!record) return err(mindlogError('NOT_FOUND', "The requested resource wasn't found."));
    const allowed = await r.allows(
      schema.value.viewRule,
      collection,
      ruleRecord(collection, record),
    );
    if (!allowed.ok) return allowed;
    return allowed.value
      ? ok(record)
      : err(mindlogError('NOT_FOUND', "The requested resource wasn't found."));
  }

  async #shape(
    r: RecordReader,
    collection: string,
    rows: RawRecord[],
    q: Pick<ListQuery, 'expand' | 'fields'>,
  ): Promise<RecordView[]> {
    const views = rows.map((row) => r.present(collection, row));
    if (q.expand) await r.expand(collection, views, rows, q.expand);
    return q.fields ? views.map((v) => pick(v, q.fields ?? '')) : views;
  }

  async create(
    ctx: RequestContext,
    collection: string,
    body: Body,
    extras?: WriteExtras,
  ): Promise<Result<WriteResult, MindlogError>> {
    const w = await this.#writer(ctx);
    return w.ok ? w.value.create(collection, body, extras) : w;
  }

  async update(
    ctx: RequestContext,
    collection: string,
    id: string,
    body: Body,
    extras?: WriteExtras,
  ): Promise<Result<WriteResult, MindlogError>> {
    const w = await this.#writer(ctx);
    return w.ok ? w.value.update(collection, id, body, extras) : w;
  }

  async delete(
    ctx: RequestContext,
    collection: string,
    id: string,
  ): Promise<Result<RawRecord, MindlogError>> {
    const w = await this.#writer(ctx);
    return w.ok ? w.value.delete(collection, id) : w;
  }

  /** Runs a collection call another node forwarded here. */
  forwarded(rangeId: bigint, caller: Caller, call: RangeCall): Promise<KvReply> {
    if (!isUserTenant(caller.tenant))
      return Promise.resolve(replies.error('INVALID_ARGUMENT', 'not a user tenant'));
    return this.ranges.forwarded(rangeId, caller, call);
  }
}

function ruleIssues(
  rule: string,
  collection: string,
  view: ReturnType<typeof schemaView>,
): RuleIssue[] {
  const parsed = parse(rule);
  if (!parsed.ok) {
    const at = /at (\d+): (.*)$/.exec(parsed.error.message);
    return [
      { message: at?.[2] ?? parsed.error.message, from: Number(at?.[1] ?? 0), to: rule.length },
    ];
  }
  return checkRule(parsed.value, { collection, schema: view, allowHidden: true });
}

type Sort = { field: string; desc: boolean }[];

function sortOf(
  spec: string | undefined,
  schema: CollectionSchema,
  superuser: boolean,
): Result<Sort | undefined, MindlogError> {
  if (spec === undefined || spec.trim() === '') return ok(undefined);
  const fields = storedFields(schema);
  const out: Sort = [];
  for (const part of spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')) {
    const desc = part.startsWith('-');
    const field = part.replace(/^[-+]/, '');
    const f = fields.find((x) => x.name === field);
    const system = ['id', 'created', 'updated'].includes(field);
    if (!system && (f === undefined || (f.hidden && !superuser))) {
      return err(mindlogError('INVALID_ARGUMENT', `cannot sort by ${field}`));
    }
    out.push({ field, desc });
  }
  return ok(out);
}

function sortRows(collection: string, rows: RawRecord[], sort: Sort): RawRecord[] {
  const keyed = rows.map((r) => ({ r, v: ruleRecord(collection, r) }));
  keyed.sort((a, b) => {
    for (const { field, desc } of sort) {
      const x = a.v[field];
      const y = b.v[field];
      const c = compareValues('<', x, y) ? -1 : compareValues('>', x, y) ? 1 : 0;
      if (c !== 0) return desc ? -c : c;
    }
    return a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0;
  });
  return keyed.map((k) => k.r);
}

/** `fields=id,title,expand` keeps those top-level keys; `*` keeps all. */
function pick(view: RecordView, fields: string): RecordView {
  const keep = fields.split(',').map((f) => f.trim().split('.')[0] ?? '');
  if (keep.includes('*')) return view;
  return Object.fromEntries(Object.entries(view).filter(([k]) => keep.includes(k)));
}
