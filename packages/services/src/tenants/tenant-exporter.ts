import { gzipSync } from 'node:zlib';
import type { BlobStore } from '@mindlog/blob';
import type { Clock, Logger, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { CollectionService } from '../collections/collection-service.js';
import type { KvBrowser } from '../kv-browser/kv-browser.js';
import type { KvService } from '../kv/kv-service.js';
import type { MemoryService } from '../memory/memory-service.js';
import type { ExportState, TenantService } from './tenant-service.js';

export interface TenantExporterDeps {
  readonly tenants: TenantService;
  readonly kv: KvService;
  readonly browser: KvBrowser;
  readonly memory?: MemoryService;
  readonly collections?: CollectionService;
  readonly blob: BlobStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly ids: () => string;
}

/** Largest archive, before compression; the blob store takes whole buffers. */
const MAX_BYTES = 256 * 1024 * 1024;
const PER_PAGE = 500;
const encoder = new TextEncoder();

/**
 * A tenant's data as one archive (PLAN 24 phase 10): gzipped NDJSON, one line
 * per KV key, collection record, user scope's `.mcube` and file, written to
 * the blob store under `exports/<tenant>/`. It runs in the background on the
 * node that took the request; its state is kept in the tenant's registry row.
 * shortcut: memory scopes come from this node's replicas and a node crash leaves the export `running`; fan out to every range and resume from a checkpoint when exports must be complete on a cluster.
 */
export class TenantExporter {
  constructor(private readonly deps: TenantExporterDeps) {}

  /** Starts an export; the returned state is `running`. */
  async start(tenant: string): Promise<Result<ExportState, MindlogError>> {
    const current = await this.deps.tenants.exportState(tenant);
    if (!current.ok) return current;
    if (current.value?.status === 'running')
      return err(mindlogError('ALREADY_EXISTS', 'an export of this tenant is already running'));
    const state: ExportState = {
      id: this.deps.ids(),
      status: 'running',
      startedAt: Number(this.deps.clock.now()),
    };
    const saved = await this.deps.tenants.setExport(tenant, state);
    if (!saved.ok) return saved;
    void this.#run(tenant, state);
    return ok(state);
  }

  async #run(tenant: string, state: ExportState): Promise<void> {
    const lines: string[] = [];
    let size = 0;
    const add = (line: unknown) => {
      const text = JSON.stringify(line);
      size += text.length + 1;
      if (size > MAX_BYTES) throw new Error(`the export is over ${String(MAX_BYTES)} bytes`);
      lines.push(text);
    };
    let finished: ExportState;
    try {
      const info = await this.deps.tenants.get(tenant);
      if (!info.ok) throw new Error(info.error.message);
      add({ type: 'tenant', info: info.value });
      await this.#kv(tenant, add);
      await this.#collections(tenant, add);
      await this.#memory(tenant, add);
      await this.#files(tenant, add);
      const blob = `exports/${tenant}/${state.id}.ndjson.gz`;
      const bytes = gzipSync(encoder.encode(`${lines.join('\n')}\n`));
      const put = await this.deps.blob.put(blob, bytes);
      if (!put.ok) throw new Error(put.error.message);
      finished = {
        ...state,
        status: 'done',
        finishedAt: Number(this.deps.clock.now()),
        blob,
        bytes: bytes.length,
      };
    } catch (cause) {
      this.deps.logger.warn('tenant export failed', { tenant, err: cause });
      finished = {
        ...state,
        status: 'failed',
        finishedAt: Number(this.deps.clock.now()),
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    await this.deps.tenants.setExport(tenant, finished);
  }

  async #kv(tenant: string, add: (line: unknown) => void): Promise<void> {
    const session = this.deps.kv.openSession(`export:${tenant}`);
    session.tenant = tenant;
    session.authenticated = true;
    session.principal = 'system:export';
    let cursor = '0';
    do {
      const page = await this.deps.browser.scan(session, { cursor, count: PER_PAGE });
      if (!page.ok) throw new Error(page.error.message);
      for (const summary of page.value.keys) {
        const name = Buffer.from(summary.key, summary.encoding === 'base64' ? 'base64' : 'utf8');
        const detail = await this.deps.browser.read(session, new Uint8Array(name), {
          encoding: summary.encoding,
          limit: 10_000,
        });
        // A key deleted since the scan is simply not exported.
        if (detail.ok) add({ type: 'kv', key: detail.value });
      }
      cursor = page.value.cursor;
    } while (cursor !== '0');
  }

  async #collections(tenant: string, add: (line: unknown) => void): Promise<void> {
    const collections = this.deps.collections;
    if (!collections) return;
    const ctx = { identity: { kind: 'superuser' as const, email: 'system:export' }, tenant };
    const listed = await collections.listCollections(ctx);
    if (!listed.ok) {
      if (listed.error.code === 'UNIMPLEMENTED') return;
      throw new Error(listed.error.message);
    }
    for (const { schema } of listed.value) {
      add({ type: 'collection', schema });
      for (let page = 1; ; page++) {
        const records = await collections.list(ctx, schema.name, {
          page,
          perPage: PER_PAGE,
          skipTotal: true,
        });
        if (!records.ok) throw new Error(records.error.message);
        for (const record of records.value.items)
          add({ type: 'record', collection: schema.name, record });
        if (records.value.items.length < PER_PAGE) break;
      }
    }
  }

  async #memory(tenant: string, add: (line: unknown) => void): Promise<void> {
    const memory = this.deps.memory;
    if (!memory) return;
    const caller = { tenant, principal: 'system:export' };
    const scopes = await memory.scopes(caller, { limit: 1000 });
    if (!scopes.ok) throw new Error(scopes.error.message);
    for (const user of scopes.value.users) {
      const cube = await memory.exportCube(caller, { scope: { user } });
      if (!cube.ok) throw new Error(cube.error.message);
      add({ type: 'memory', user, mcube: cube.value.data });
    }
  }

  async #files(tenant: string, add: (line: unknown) => void): Promise<void> {
    const listed = await this.deps.blob.list(`files/${tenant}`);
    if (!listed.ok) throw new Error(listed.error.message);
    for (const key of listed.value) {
      const got = await this.deps.blob.get(key);
      if (got.ok && got.value)
        add({ type: 'file', key, data: Buffer.from(got.value).toString('base64') });
    }
  }

  /** The finished archive, for an authorized download. */
  async archive(tenant: string): Promise<Result<Uint8Array, MindlogError>> {
    const state = await this.deps.tenants.exportState(tenant);
    if (!state.ok) return state;
    const blob = state.value?.status === 'done' ? state.value.blob : undefined;
    if (!blob) return err(mindlogError('NOT_FOUND', 'no finished export of this tenant'));
    const got = await this.deps.blob.get(blob);
    if (!got.ok) return got;
    return got.value ? ok(got.value) : err(mindlogError('NOT_FOUND', 'the export archive is gone'));
  }
}
