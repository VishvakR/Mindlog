import { create, toBinary } from '@bufbuild/protobuf';
import { randomBytes } from 'node:crypto';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { actorOf, hashPassword, randomSecret, recordId, verifyPassword } from '@mindlog/auth';
import type { CollectionSchema, FieldDef } from '@mindlog/collections';
import {
  RECORD_ID,
  fieldNormalize,
  fieldZero,
  isMulti,
  storedFields,
  viewSources,
} from '@mindlog/collections';
import type { JobSpec } from '@mindlog/proto';
import { JobSpecSchema, RecordOpKind, RecordOpSchema, RecordWriteSchema } from '@mindlog/proto';
import { formatDate } from '@mindlog/rules';
import {
  HOOK_JOB,
  cascadeJob,
  fileJanitorJob,
  holds,
  referencesTo,
  viewRefreshJob,
} from './collection-jobs.js';
import type { CollectionRanges, ProposeOutcome, RawRecord } from './collection-ranges.js';
import type { HookEvent, RecordHooks } from './record-hooks.js';
import type { RecordReader, RecordView } from './record-reader.js';
import { isSuperuser, ruleRecord } from './record-reader.js';

/** The embedding call `vector` fields need (`@mindlog/models-client` implements it). */
export interface TextEmbedder {
  embed(
    texts: readonly string[],
    kind: 'passage',
  ): Promise<Result<{ readonly vectors: readonly Float32Array[] }, MindlogError>>;
}

export type Body = Record<string, unknown>;

/** Extra effects of a write: files staged before proposing, jobs to enqueue with it. */
export interface WriteExtras {
  /** File field values to set (names already uploaded), applied after modifiers. */
  readonly files?: Readonly<Record<string, readonly string[]>>;
  readonly enqueue?: readonly JobSpec[];
  /** Stores the uploaded blobs; called once the rules passed, before proposing. */
  readonly persist?: () => Promise<Result<void, MindlogError>>;
}

export interface WriteResult {
  readonly record: RecordView;
  readonly raw: RawRecord;
  /** The model service was down: vector fields were left empty. */
  readonly degraded: boolean;
}

const MAX_CONFLICT_RETRIES = 3;
const NON_FIELDS = new Set([
  'id',
  'created',
  'updated',
  'collectionName',
  'collectionId',
  'expand',
]);
const AUTH_INPUTS = new Set(['passwordConfirm', 'oldPassword']);

const invalid = (fields: Record<string, string>, message = 'Failed to validate record.') =>
  err(mindlogError('INVALID_ARGUMENT', message, { fields }));

/**
 * Creates, updates and deletes records as the requester (PLAN 16): rules,
 * field modifiers, password hashing, autodates, vectors and relation checks
 * before proposing, then one fenced `RecordWrite`.
 */
export class RecordWriter {
  constructor(
    private readonly reader: RecordReader,
    private readonly d: {
      readonly ranges: CollectionRanges;
      readonly embedder?: TextEmbedder;
      readonly hooks?: RecordHooks;
      readonly nowMs: () => number;
    },
  ) {}

  async create(
    collection: string,
    body: Body,
    extras: WriteExtras = {},
  ): Promise<Result<WriteResult, MindlogError>> {
    const schema = this.reader.schema(collection);
    if (!schema.ok) return schema;
    if (schema.value.type === 'view')
      return err(mindlogError('INVALID_ARGUMENT', 'View collections are read-only.'));
    if (schema.value.createRule === null && !isSuperuser(this.reader.ctx)) {
      return err(mindlogError('PERMISSION_DENIED', 'Only superusers can perform this action.'));
    }
    const id = typeof body['id'] === 'string' && body['id'] !== '' ? body['id'] : recordId();
    if (!RECORD_ID.test(id)) return invalid({ id: 'must be 15 characters of a-z and 0-9' });
    const data = await this.#build(schema.value, undefined, body, extras);
    if (!data.ok) return data;
    const now = this.d.nowMs();
    const draft: RawRecord = {
      id,
      data: data.value.data,
      createdMs: now,
      updatedMs: now,
      version: '0',
    };
    const allowed = await this.reader.allows(
      schema.value.createRule,
      collection,
      ruleRecord(collection, draft),
      body,
    );
    if (!allowed.ok) return allowed;
    if (!allowed.value) return err(mindlogError('INVALID_ARGUMENT', 'Failed to create record.'));
    const hooked = await this.#before('onRecordCreate', collection, body, draft);
    if (!hooked.ok) return hooked;
    const final =
      hooked.value === body
        ? data
        : await this.#build(schema.value, undefined, hooked.value, extras);
    if (!final.ok) return final;
    const stored = await extras.persist?.();
    if (stored && !stored.ok) return stored;
    const created = { ...draft, data: final.value.data };
    const written = await this.#propose(collection, RecordOpKind.CREATE, id, final.value.data, 0n, [
      ...(extras.enqueue ?? []),
      ...this.#fileJobs(schema.value, undefined, final.value.data, extras),
      ...this.#afterJobs('onRecordCreate', collection, created),
    ]);
    if (!written.ok) return written;
    const raw = { ...created, version: written.value.versions[0] ?? '0' };
    return ok({
      record: this.reader.present(collection, raw),
      raw,
      degraded: final.value.degraded,
    });
  }

  async update(
    collection: string,
    id: string,
    body: Body,
    extras: WriteExtras = {},
  ): Promise<Result<WriteResult, MindlogError>> {
    const schema = this.reader.schema(collection);
    if (!schema.ok) return schema;
    if (schema.value.type === 'view')
      return err(mindlogError('INVALID_ARGUMENT', 'View collections are read-only.'));
    for (let attempt = 0; ; attempt++) {
      const existing = await this.#existing(collection, id, schema.value.updateRule, body);
      if (!existing.ok) return existing;
      const hooked = await this.#before('onRecordUpdate', collection, body, existing.value);
      if (!hooked.ok) return hooked;
      const data = await this.#build(schema.value, existing.value, hooked.value, extras);
      if (!data.ok) return data;
      const stored = await extras.persist?.();
      if (stored && !stored.ok) return stored;
      const written = await this.#propose(
        collection,
        RecordOpKind.UPDATE,
        id,
        data.value.data,
        BigInt(existing.value.version),
        [
          ...(extras.enqueue ?? []),
          ...this.#fileJobs(schema.value, existing.value.data, data.value.data, extras),
          ...this.#afterJobs('onRecordUpdate', collection, {
            ...existing.value,
            data: data.value.data,
          }),
        ],
      );
      if (!written.ok && written.error.code === 'CONFLICT' && attempt < MAX_CONFLICT_RETRIES) {
        this.reader.forget(collection, id);
        continue;
      }
      if (!written.ok) return written;
      const raw: RawRecord = {
        ...existing.value,
        data: data.value.data,
        updatedMs: this.d.nowMs(),
        version: written.value.versions[0] ?? '0',
      };
      return ok({
        record: this.reader.present(collection, raw),
        raw,
        degraded: data.value.degraded,
      });
    }
  }

  async delete(collection: string, id: string): Promise<Result<RawRecord, MindlogError>> {
    const schema = this.reader.schema(collection);
    if (!schema.ok) return schema;
    if (schema.value.type === 'view')
      return err(mindlogError('INVALID_ARGUMENT', 'View collections are read-only.'));
    for (let attempt = 0; ; attempt++) {
      const existing = await this.#existing(collection, id, schema.value.deleteRule);
      if (!existing.ok) return existing;
      const hooked = await this.#before('onRecordDelete', collection, {}, existing.value);
      if (!hooked.ok) return hooked;
      const references = referencesTo(this.reader.catalog, collection);
      for (const { schema: from, field } of references) {
        if (!field.required || field.cascadeDelete) continue;
        const using = await this.reader.matching(from.name, holds(field.name, id), 1);
        if (!using.ok) return using;
        if (using.value.length > 0)
          return err(
            mindlogError(
              'INVALID_ARGUMENT',
              `The record is required by ${from.name}.${field.name}.`,
            ),
          );
      }
      // The old data travels in the op so the change feed can check rules against the deleted record.
      const written = await this.#propose(
        collection,
        RecordOpKind.DELETE,
        id,
        existing.value.data,
        BigInt(existing.value.version),
        [
          ...(references.length > 0 ? [cascadeJob(id)] : []),
          ...this.#fileJobs(schema.value, existing.value.data, undefined, {}),
          ...this.#afterJobs('onRecordDelete', collection, existing.value),
        ],
      );
      if (!written.ok && written.error.code === 'CONFLICT' && attempt < MAX_CONFLICT_RETRIES) {
        this.reader.forget(collection, id);
        continue;
      }
      return written.ok ? ok(existing.value) : written;
    }
  }

  /** The record if the requester passes `rule` for it; a failed rule is `NOT_FOUND` (PocketBase). */
  async #existing(
    collection: string,
    id: string,
    rule: string | null,
    body?: Body,
  ): Promise<Result<RawRecord, MindlogError>> {
    if (rule === null && !isSuperuser(this.reader.ctx)) {
      return err(mindlogError('PERMISSION_DENIED', 'Only superusers can perform this action.'));
    }
    const found = await this.reader.get(collection, [id]);
    if (!found.ok) return found;
    const record = found.value[0];
    const notFound = err(mindlogError('NOT_FOUND', "The requested resource wasn't found."));
    if (!record) return notFound;
    const allowed = await this.reader.allows(
      rule,
      collection,
      ruleRecord(collection, record),
      body,
    );
    if (!allowed.ok) return allowed;
    return allowed.value ? ok(record) : notFound;
  }

  /** The full record data after applying the body to `existing` (or to zero values). */
  async #build(
    schema: CollectionSchema,
    existing: RawRecord | undefined,
    body: Body,
    extras: WriteExtras,
  ): Promise<Result<{ data: Body; degraded: boolean }, MindlogError>> {
    const fields = storedFields(schema);
    const problems: Record<string, string> = {};
    const data: Body = {};
    for (const f of fields) data[f.name] = existing ? existing.data[f.name] : fieldZero(f);
    const isAuth = schema.type === 'auth';
    for (const key of Object.keys(body)) {
      const name = key.replace(/^\+|[+-]$/g, '');
      if (NON_FIELDS.has(key) || (isAuth && AUTH_INPUTS.has(key))) continue;
      const f = fields.find((x) => x.name === name);
      if (f === undefined) problems[key] = 'unknown field';
      else if (f.type === 'autodate' || f.type === 'vector' || f.name === 'tokenKey')
        problems[key] = 'is set by Mindlog';
      else if (f.type === 'password') continue;
      else {
        const problem = applyValue(f, data, key, body[key]);
        if (problem !== undefined) problems[key] = problem;
      }
    }
    // A file field only keeps names the record already has: a client naming another
    // record's file would otherwise gain access to it through this record's rules.
    for (const f of fields) {
      if (f.type !== 'file') continue;
      const had = new Set(existing ? asStrings(existing.data[f.name]) : []);
      if (asStrings(data[f.name]).some((n) => !had.has(n)))
        problems[f.name] = 'files must be uploaded';
    }
    for (const [name, files] of Object.entries(extras.files ?? {})) {
      const f = fields.find((x) => x.name === name);
      if (f?.type !== 'file') problems[name] = 'not a file field';
      else data[name] = isMulti(f) ? [...asStrings(data[name]), ...files] : (files.at(-1) ?? '');
    }
    if (isAuth) await this.#authFields(schema, existing, body, data, problems);
    const relations = await this.#checkRelations(fields, data, existing);
    Object.assign(problems, relations);
    if (Object.keys(problems).length > 0) return invalid(problems);
    const now = formatDate(this.d.nowMs());
    for (const f of fields) {
      if (
        f.type === 'autodate' &&
        ((existing === undefined && f.onCreate) || (existing !== undefined && f.onUpdate))
      )
        data[f.name] = now;
    }
    const degraded = await this.#vectors(fields, data, existing);
    return ok({ data, degraded });
  }

  /** Passwords, token keys and the fields only superusers (or `manageRule`) may change. */
  async #authFields(
    schema: CollectionSchema,
    existing: RawRecord | undefined,
    body: Body,
    data: Body,
    problems: Record<string, string>,
  ): Promise<void> {
    const manager = await this.#manages(schema, existing);
    const password = body['password'];
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8)
        problems['password'] = 'at least 8 characters';
      else if (body['passwordConfirm'] !== password)
        problems['passwordConfirm'] = 'does not match the password';
      else if (existing && !manager) {
        const old = body['oldPassword'];
        const stored =
          typeof existing.data['password'] === 'string' ? existing.data['password'] : '';
        if (typeof old !== 'string' || !(await verifyPassword(stored, old)))
          problems['oldPassword'] = 'is not the current password';
      }
      if (
        problems['password'] === undefined &&
        problems['passwordConfirm'] === undefined &&
        problems['oldPassword'] === undefined
      ) {
        data['password'] = await hashPassword(password as string);
        data['tokenKey'] = randomSecret(24);
      }
    } else if (!existing) problems['password'] = 'cannot be blank';
    if (!existing)
      data['tokenKey'] =
        data['tokenKey'] === '' || data['tokenKey'] === undefined
          ? randomSecret(24)
          : data['tokenKey'];
    if (!manager) {
      if (body['verified'] !== undefined) problems['verified'] = 'only superusers can change it';
      if (existing && body['email'] !== undefined && body['email'] !== existing.data['email']) {
        problems['email'] = 'only superusers can change it';
      }
      if (!existing) data['verified'] = false;
    }
    if (data['email'] === '' && problems['email'] === undefined)
      problems['email'] = 'cannot be blank';
  }

  /** Runs before hooks after the rules passed; system collections have none. */
  async #before(
    event: HookEvent,
    collection: string,
    body: Body,
    record: RawRecord,
  ): Promise<Result<Body, MindlogError>> {
    const hooks = this.d.hooks;
    if (!hooks || collection.startsWith('_') || !hooks.has(event, collection, 'before'))
      return ok(body);
    const ran = await hooks.run({
      event,
      collection,
      phase: 'before',
      body,
      record: ruleRecord(collection, record),
    });
    return ran.ok ? ok({ ...ran.value }) : ran;
  }

  /** After hooks are jobs of the write, so they run even if this node dies right after it. */
  #afterJobs(event: HookEvent, collection: string, record: RawRecord): JobSpec[] {
    if (
      !this.d.hooks ||
      collection.startsWith('_') ||
      !this.d.hooks.has(event, collection, 'after')
    )
      return [];
    const call = { event, collection, phase: 'after', record: ruleRecord(collection, record) };
    return [
      create(JobSpecSchema, {
        id: `hook-${recordId()}`,
        kind: HOOK_JOB,
        payload: new TextEncoder().encode(JSON.stringify(call)),
      }),
    ];
  }

  /** A janitor run when this write uploads files or stops naming some. */
  #fileJobs(
    schema: CollectionSchema,
    before: Body | undefined,
    after: Body | undefined,
    extras: WriteExtras,
  ): JobSpec[] {
    const names = (d: Body | undefined) =>
      storedFields(schema).flatMap((f) => (f.type === 'file' ? asStrings(d?.[f.name]) : []));
    const kept = new Set(names(after));
    const dropped = names(before).some((n) => !kept.has(n));
    return dropped || Object.keys(extras.files ?? {}).length > 0
      ? [fileJanitorJob(this.d.nowMs())]
      : [];
  }

  /** Superusers, and requesters who pass `manageRule` for the record, manage its auth fields (PocketBase). */
  async #manages(schema: CollectionSchema, existing: RawRecord | undefined): Promise<boolean> {
    if (isSuperuser(this.reader.ctx)) return true;
    if (schema.manageRule === null) return false;
    const record = existing ? ruleRecord(schema.name, existing) : null;
    const allowed = await this.reader.allows(schema.manageRule, schema.name, record);
    return allowed.ok && allowed.value;
  }

  async #checkRelations(
    fields: readonly FieldDef[],
    data: Body,
    existing: RawRecord | undefined,
  ): Promise<Record<string, string>> {
    const problems: Record<string, string> = {};
    for (const f of fields) {
      if (f.type !== 'relation') continue;
      const ids = asStrings(data[f.name]);
      const before = new Set(existing ? asStrings(existing.data[f.name]) : []);
      const added = ids.filter((id) => !before.has(id) && RECORD_ID.test(id));
      if (added.length === 0) continue;
      const found = await this.reader.get(f.collection, added);
      if (!found.ok) problems[f.name] = found.error.message;
      else if (found.value.length !== added.length)
        problems[f.name] = 'refers to a record that does not exist';
    }
    return problems;
  }

  /** Embeds `vector` fields whose source text changed; on failure they stay empty (degraded). */
  async #vectors(
    fields: readonly FieldDef[],
    data: Body,
    existing: RawRecord | undefined,
  ): Promise<boolean> {
    let degraded = false;
    for (const f of fields) {
      if (f.type !== 'vector') continue;
      const text = data[f.source];
      if (existing && existing.data[f.source] === text && existing.data[f.name] !== null) continue;
      if (typeof text !== 'string' || text === '' || !this.d.embedder) {
        data[f.name] = null;
        degraded ||= typeof text === 'string' && text !== '';
        continue;
      }
      const embedded = await this.d.embedder.embed([text], 'passage');
      const vector = embedded.ok ? embedded.value.vectors[0] : undefined;
      data[f.name] = vector ? Array.from(vector, (x) => Math.round(x * 1e6) / 1e6) : null;
      degraded ||= vector === undefined;
    }
    return degraded;
  }

  /** Every write to a collection that views read refreshes them, durably, with the write. */
  #viewJobs(collection: string): JobSpec[] {
    const read = [...this.reader.catalog.values()].some(
      ({ schema }) => schema.view && viewSources(schema.view).includes(collection),
    );
    return read ? [viewRefreshJob(this.d.nowMs())] : [];
  }

  async #propose(
    collection: string,
    kind: RecordOpKind,
    id: string,
    data: Body | undefined,
    expectVersion: bigint,
    enqueue: readonly JobSpec[] = [],
  ): Promise<Result<ProposeOutcome, MindlogError>> {
    const write = create(RecordWriteSchema, {
      collection,
      ops: [
        create(RecordOpSchema, {
          kind,
          id,
          data:
            data === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(data)),
          expectVersion,
        }),
      ],
      enqueue: [...enqueue, ...this.#viewJobs(collection)],
    });
    return this.d.ranges.run<ProposeOutcome>(
      this.reader.caller,
      collection,
      {
        op: 'propose',
        body: 'recordWrite',
        bytes: Buffer.from(toBinary(RecordWriteSchema, write)).toString('base64'),
        actor: actorOf(this.reader.ctx.identity),
      },
      randomBytes(16),
    );
  }
}

function asStrings(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return typeof v === 'string' && v !== '' ? [v] : [];
}

/** Sets `field`, or applies a modifier (`field+`, `+field`, `field-`, PLAN 16.2). */
function applyValue(f: FieldDef, data: Body, key: string, raw: unknown): string | undefined {
  const prepend = key.startsWith('+');
  const append = !prepend && key.endsWith('+');
  const remove = key.endsWith('-');
  if (!prepend && !append && !remove) {
    const value = fieldNormalize(f, raw);
    if (value === undefined) return 'invalid value';
    data[f.name] = value;
    return undefined;
  }
  if (f.type === 'number') {
    const delta = fieldNormalize(f, raw);
    if (typeof delta !== 'number' || prepend) return 'invalid modifier';
    data[f.name] =
      (typeof data[f.name] === 'number' ? (data[f.name] as number) : 0) + (remove ? -delta : delta);
    return undefined;
  }
  if (f.type !== 'select' && f.type !== 'relation' && f.type !== 'file')
    return 'modifiers work on number, select, relation and file fields';
  const values = asStrings(raw);
  const current = asStrings(data[f.name]);
  const next = remove
    ? current.filter((v) => !values.includes(v))
    : prepend
      ? [...values, ...current]
      : [...current, ...values];
  data[f.name] = isMulti(f) ? [...new Set(next)] : (next.at(-1) ?? '');
  return undefined;
}
