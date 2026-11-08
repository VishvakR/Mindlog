import { randomBytes } from 'node:crypto';
import type { BlobStore } from '@mindlog/blob';
import type { Clock, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { CollectionSchema, FieldDef } from '@mindlog/collections';
import { storedFields } from '@mindlog/collections';
import type { AppAuthService } from './app-auth.js';
import type { CollectionService } from './collection-service.js';
import { FILE_GRACE_MS } from './collection-jobs.js';
import type { RawRecord } from './collection-ranges.js';
import type { RequestContext } from './record-reader.js';
import type { Body, WriteResult } from './record-writer.js';

/** One uploaded file of a request. */
export interface Upload {
  readonly field: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly bytes: Uint8Array;
}

/** Makes thumbnails; `spec` is `WxH` with an optional `t`, `b` or `f` (PLAN 16.5). */
export interface Thumbnailer {
  resize(bytes: Uint8Array, spec: string): Promise<Result<Uint8Array, MindlogError>>;
}

export interface ServedFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** False for types a browser may safely render on our origin. */
  readonly attachment: boolean;
}

// Only inert types render inline: HTML and SVG on our origin would run script as the viewer.
const INLINE: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
};
const THUMBABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const notFound = () => err(mindlogError('NOT_FOUND', "The requested resource wasn't found."));
const extOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
const hexTenant = (tenant: string): string => Buffer.from(tenant).toString('hex');
const dir = (root: 'files' | 'thumbs', tenant: string, collection: string): string =>
  `${root}/${hexTenant(tenant)}/${collection}`;
const STAMP = 9;
const RANDOM = 6;

/** `<base>_<upload time><random>.<ext>`: unique per upload, so failed writes can delete theirs. */
function storedName(original: string, nowMs: number): string {
  const ext = extOf(original).slice(0, 16);
  const base = original
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 100);
  const stamp = nowMs.toString(36).padStart(STAMP, '0');
  const rand = randomBytes(8).toString('hex').slice(0, RANDOM);
  return `${base || 'file'}_${stamp}${rand}${ext ? `.${ext}` : ''}`;
}

function uploadedAt(name: string): number | undefined {
  const m = new RegExp(`_([0-9a-z]{${String(STAMP)}})[0-9a-f]{${String(RANDOM)}}(?:\\.|$)`).exec(
    name,
  );
  return m?.[1] === undefined ? undefined : parseInt(m[1], 36);
}

const namesIn = (schema: CollectionSchema, r: RawRecord): string[] =>
  storedFields(schema).flatMap((f) => {
    if (f.type !== 'file') return [];
    const v = r.data[f.name];
    return Array.isArray(v) ? (v as string[]) : typeof v === 'string' && v !== '' ? [v] : [];
  });

/**
 * Record files (PLAN 16.5): the blob is written after the rules passed and
 * before the record is proposed; a refused write removes its blobs, and the
 * janitor job removes what a crash or a replaced file left behind.
 *
 * shortcut: files are buffered, because `BlobStore` has no streaming; add
 * streaming puts when files should exceed the request limit.
 */
export class RecordFiles {
  constructor(
    private readonly d: {
      readonly collections: CollectionService;
      readonly blob: BlobStore;
      readonly auth: AppAuthService;
      readonly clock: Clock;
      readonly thumbnailer?: Thumbnailer;
    },
  ) {}

  #prepare(
    schema: CollectionSchema,
    uploads: readonly Upload[],
  ): Result<{ names: Record<string, string[]>; stored: [string, Uint8Array][] }, MindlogError> {
    const names: Record<string, string[]> = {};
    const stored: [string, Uint8Array][] = [];
    const problems: Record<string, string> = {};
    for (const u of uploads) {
      const f = storedFields(schema).find((x) => x.name === u.field);
      if (f?.type !== 'file') {
        problems[u.field] = 'is not a file field';
        continue;
      }
      if (f.maxSize > 0 && u.bytes.length > f.maxSize)
        problems[u.field] = `at most ${String(f.maxSize)} bytes`;
      // shortcut: trusts the client's declared type; sniff the bytes if this guards anything sensitive.
      if (f.mimeTypes.length > 0 && !f.mimeTypes.includes(u.mimetype))
        problems[u.field] = `${u.mimetype} is not allowed`;
      const name = storedName(u.filename, Number(this.d.clock.now()));
      (names[u.field] ??= []).push(name);
      stored.push([name, u.bytes]);
    }
    if (Object.keys(problems).length > 0) {
      return err(
        mindlogError('INVALID_ARGUMENT', 'Failed to validate record.', { fields: problems }),
      );
    }
    return ok({ names, stored });
  }

  async #write(
    ctx: RequestContext,
    collection: string,
    uploads: readonly Upload[],
    run: (extras: {
      files: Record<string, string[]>;
      persist: () => Promise<Result<void, MindlogError>>;
    }) => Promise<Result<WriteResult, MindlogError>>,
  ): Promise<Result<WriteResult, MindlogError>> {
    const reader = await this.d.collections.reader(ctx);
    if (!reader.ok) return reader;
    const schema = reader.value.schema(collection);
    if (!schema.ok) return schema;
    const prepared = this.#prepare(schema.value, uploads);
    if (!prepared.ok) return prepared;
    const prefix = dir('files', ctx.tenant, collection);
    let persisted = false;
    const result = await run({
      files: prepared.value.names,
      persist: async () => {
        if (persisted) return ok(undefined);
        for (const [name, bytes] of prepared.value.stored) {
          const put = await this.d.blob.put(`${prefix}/${name}`, bytes);
          if (!put.ok) return put;
        }
        persisted = true;
        return ok(undefined);
      },
    });
    if (!result.ok) {
      for (const [name] of prepared.value.stored) await this.d.blob.delete(`${prefix}/${name}`);
    }
    return result;
  }

  create(ctx: RequestContext, collection: string, body: Body, uploads: readonly Upload[]) {
    return this.#write(ctx, collection, uploads, (extras) =>
      this.d.collections.create(ctx, collection, body, extras),
    );
  }

  update(
    ctx: RequestContext,
    collection: string,
    id: string,
    body: Body,
    uploads: readonly Upload[],
  ) {
    return this.#write(ctx, collection, uploads, (extras) =>
      this.d.collections.update(ctx, collection, id, body, extras),
    );
  }

  /** The file, if the requester may view its record. A `?token=` file token stands in for the bearer. */
  async read(
    bearer: RequestContext,
    collection: string,
    id: string,
    filename: string,
    q: { token?: string; thumb?: string },
  ): Promise<Result<ServedFile, MindlogError>> {
    let ctx: RequestContext = { ...bearer, context: 'protectedFile' };
    if (q.token !== undefined) {
      const checked = await this.d.auth.check(q.token, ['file']);
      if (!checked.ok) return checked;
      const { sub, col, ten } = checked.value.claims;
      ctx = {
        ...ctx,
        tenant: ten,
        identity: { kind: 'record', tenant: ten, collection: col, id: sub },
      };
    }
    const reader = await this.d.collections.reader(ctx);
    if (!reader.ok) return reader;
    const schema = reader.value.schema(collection);
    if (!schema.ok) return schema;
    const record = await this.d.collections.visible(reader.value, collection, id);
    if (!record.ok) return record;
    const field = storedFields(schema.value).find(
      (f): f is Extract<FieldDef, { type: 'file' }> =>
        f.type === 'file' && [record.value.data[f.name]].flat().includes(filename),
    );
    if (!field) return notFound();
    if (field.protected && ctx.identity.kind === 'anonymous') return notFound();
    const ext = extOf(filename);
    const contentType = INLINE[ext] ?? 'application/octet-stream';
    const key = `${dir('files', ctx.tenant, collection)}/${filename}`;
    const thumbed = q.thumb !== undefined && field.thumbs.includes(q.thumb) && THUMBABLE.has(ext);
    const bytes = thumbed
      ? await this.#thumb(ctx.tenant, collection, filename, key, q.thumb ?? '')
      : await this.d.blob.get(key);
    if (!bytes.ok) return bytes;
    return bytes.value
      ? ok({ bytes: bytes.value, contentType, attachment: !(ext in INLINE) })
      : notFound();
  }

  /** The cached thumbnail, made on first use; the original when no thumbnailer is configured. */
  async #thumb(tenant: string, collection: string, filename: string, key: string, spec: string) {
    if (!this.d.thumbnailer) return this.d.blob.get(key);
    const cached = `${dir('thumbs', tenant, collection)}/${spec}_${filename}`;
    const hit = await this.d.blob.get(cached);
    if (!hit.ok || hit.value) return hit;
    const original = await this.d.blob.get(key);
    if (!original.ok || !original.value) return original;
    const made = await this.d.thumbnailer.resize(original.value, spec);
    if (!made.ok) return made;
    const put = await this.d.blob.put(cached, made.value);
    return put.ok ? ok(made.value) : put;
  }

  /** Deletes blobs no record names any more (past the upload grace) and their thumbnails. */
  async sweep(tenant: string, collection: string): Promise<Result<void, MindlogError>> {
    const ctx: RequestContext = { identity: { kind: 'superuser', email: 'system:jobs' }, tenant };
    const reader = await this.d.collections.reader(ctx);
    if (!reader.ok) return reader;
    const schema = reader.value.schema(collection);
    if (!schema.ok) return schema.error.code === 'NOT_FOUND' ? ok(undefined) : schema;
    // shortcut: MAX_SCAN limits this to collections reachable by one scan; page through them when larger.
    const records = await reader.value.matching(collection, undefined);
    if (!records.ok) return records;
    const live = new Set(records.value.flatMap((r) => namesIn(schema.value, r)));
    const now = Number(this.d.clock.now());
    const files = await this.d.blob.list(dir('files', tenant, collection));
    if (!files.ok) return files;
    for (const key of files.value) {
      const name = key.split('/').at(-1) ?? '';
      if (live.has(name) || now - (uploadedAt(name) ?? 0) < FILE_GRACE_MS) continue;
      const removed = await this.d.blob.delete(key);
      if (!removed.ok) return removed;
    }
    const thumbs = await this.d.blob.list(dir('thumbs', tenant, collection));
    if (!thumbs.ok) return thumbs;
    for (const key of thumbs.value) {
      const name = (key.split('/').at(-1) ?? '').replace(/^[^_]*_/, '');
      if (live.has(name)) continue;
      const removed = await this.d.blob.delete(key);
      if (!removed.ok) return removed;
    }
    return ok(undefined);
  }
}
