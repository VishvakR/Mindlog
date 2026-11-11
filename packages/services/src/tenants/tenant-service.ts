import type { Clock, MindlogError, Result } from '@mindlog/core';
import { SYSTEM_TENANT, err, mindlogError, ok } from '@mindlog/core';
import type { PolicyRow } from '@mindlog/auth';
import type { KvReply } from '@mindlog/proto';
import { strings, toRecord } from '../admin/kv-strings.js';
import type { KvService } from '../kv/kv-service.js';
import { Session } from '../session/session.js';
import type { CreateTenant, Quotas, Redaction, TenantInfo, TenantSettings } from './schemas.js';
import {
  createTenantSchema,
  policiesSchema,
  quotasSchema,
  tenantSettingsSchema,
} from './schemas.js';

const INDEX = 'tenants';
const rowKey = (name: string) => `tenant:${name}`;
const encoder = new TextEncoder();

const DEFAULT_RETENTION_DAYS = 90;
const NO_REDACTION: Redaction = { enabled: false, kinds: [] };

/** The latest export of a tenant (PLAN 24 phase 10). */
export interface ExportState {
  readonly id: string;
  readonly status: 'running' | 'done' | 'failed';
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** Blob key of the archive once done. */
  readonly blob?: string;
  readonly bytes?: number;
  readonly error?: string;
}

/** A registered tenant plus its replicated policy rows, as request paths read them. */
export interface TenantRecord {
  readonly info: TenantInfo;
  readonly policies: readonly PolicyRow[];
}

const invalid = (issues: readonly { path: PropertyKey[]; message: string }[]) =>
  mindlogError('INVALID_ARGUMENT', 'Invalid tenant.', {
    fields: Object.fromEntries(issues.map((i) => [i.path.join('.'), i.message])),
  });

/** How long a request path may act on a stale tenant row; bounds revocation delay. */
const CACHE_TTL_MS = 2_000;
const CACHE_MAX = 4_096;

/**
 * The tenant registry (PLAN 18.3): rows in the system tenant written through
 * the normal proposal path. A tenant that was never registered is active and
 * has no limits, so existing single-tenant setups are unaffected.
 */
export class TenantService {
  readonly #cache = new Map<string, { at: number; record: TenantRecord | undefined }>();

  constructor(private readonly deps: { readonly service: KvService; readonly clock: Clock }) {}

  #session(): Session {
    const session = new Session('tenants', SYSTEM_TENANT, true);
    session.principal = 'system:tenants';
    return session;
  }

  async #run(session: Session, ...args: string[]): Promise<Result<KvReply, MindlogError>> {
    const reply = await this.deps.service.execute(
      session,
      args.map((a) => encoder.encode(a)),
    );
    if (reply.kind.case === 'error')
      return err(
        mindlogError(reply.kind.value.code as MindlogError['code'], reply.kind.value.message),
      );
    return ok(reply);
  }

  #parse(row: Record<string, string>): TenantRecord {
    const json = <T>(field: string | undefined, fallback: T): T =>
      field ? (JSON.parse(field) as T) : fallback;
    return {
      info: {
        name: row.name ?? '',
        status: row.status === 'deleting' || row.status === 'deleted' ? row.status : 'active',
        created: new Date(Number(row.created ?? 0)).toISOString(),
        ...(row.deletingAt ? { deletingAt: new Date(Number(row.deletingAt)).toISOString() } : {}),
        quotas: json<Quotas>(row.quotas, {}),
        redaction: json<Redaction>(row.redaction, NO_REDACTION),
        auditRetentionDays: Number(row.auditRetentionDays ?? DEFAULT_RETENTION_DAYS),
      },
      policies: json<PolicyRow[]>(row.policies, []),
    };
  }

  async #read(name: string): Promise<Result<TenantRecord | undefined, MindlogError>> {
    const reply = await this.#run(this.#session(), 'HGETALL', rowKey(name));
    if (!reply.ok) return reply;
    const row = toRecord(strings(reply.value));
    return ok(row.name ? this.#parse(row) : undefined);
  }

  /** The tenant as request paths see it: cached briefly, since every request reads it. */
  async cached(name: string): Promise<Result<TenantRecord | undefined, MindlogError>> {
    const now = Number(this.deps.clock.now());
    const hit = this.#cache.get(name);
    if (hit && now - hit.at < CACHE_TTL_MS) return ok(hit.record);
    const read = await this.#read(name);
    if (!read.ok) return read;
    this.#cache.delete(name);
    this.#cache.set(name, { at: now, record: read.value });
    if (this.#cache.size > CACHE_MAX) {
      const oldest = this.#cache.keys().next();
      if (oldest.done !== true) this.#cache.delete(oldest.value);
    }
    return ok(read.value);
  }

  async create(input: CreateTenant): Promise<Result<TenantInfo, MindlogError>> {
    const parsed = createTenantSchema.safeParse(input);
    if (!parsed.success) return err(invalid(parsed.error.issues));
    const { name, quotas, redaction, auditRetentionDays } = parsed.data;
    const session = this.#session();
    const claimed = await this.#run(session, 'HSETNX', rowKey(name), 'name', name);
    if (!claimed.ok) return claimed;
    if (claimed.value.kind.case === 'integer' && claimed.value.kind.value === 0n)
      return err(mindlogError('ALREADY_EXISTS', `tenant ${name} already exists`));
    for (const args of [
      ['MULTI'],
      [
        'HSET',
        rowKey(name),
        'status',
        'active',
        'created',
        String(this.deps.clock.now()),
        'quotas',
        JSON.stringify(quotas ?? {}),
        'redaction',
        JSON.stringify(redaction ?? NO_REDACTION),
        'auditRetentionDays',
        String(auditRetentionDays ?? DEFAULT_RETENTION_DAYS),
      ],
      ['SADD', INDEX, name],
      ['EXEC'],
    ]) {
      const reply = await this.#run(session, ...args);
      if (!reply.ok) return reply;
    }
    this.#cache.delete(name);
    return this.get(name);
  }

  async get(name: string): Promise<Result<TenantInfo, MindlogError>> {
    const read = await this.#read(name);
    if (!read.ok) return read;
    return read.value ? ok(read.value.info) : err(this.#missing(name));
  }

  #missing(name: string): MindlogError {
    return mindlogError('NOT_FOUND', `no such tenant ${name}`);
  }

  async list(): Promise<Result<TenantInfo[], MindlogError>> {
    const names = await this.#run(this.#session(), 'SMEMBERS', INDEX);
    if (!names.ok) return names;
    const out: TenantInfo[] = [];
    for (const name of strings(names.value).sort()) {
      const read = await this.#read(name);
      if (!read.ok) return read;
      if (read.value) out.push(read.value.info);
    }
    return ok(out);
  }

  async #patch(name: string, fields: string[]): Promise<Result<TenantInfo, MindlogError>> {
    const existing = await this.#read(name);
    if (!existing.ok) return existing;
    if (!existing.value) return err(this.#missing(name));
    if (fields.length > 0) {
      const reply = await this.#run(this.#session(), 'HSET', rowKey(name), ...fields);
      if (!reply.ok) return reply;
    }
    this.#cache.delete(name);
    return this.get(name);
  }

  setQuotas(name: string, quotas: unknown): Promise<Result<TenantInfo, MindlogError>> {
    const parsed = quotasSchema.safeParse(quotas);
    if (!parsed.success) return Promise.resolve(err(invalid(parsed.error.issues)));
    return this.#patch(name, ['quotas', JSON.stringify(parsed.data)]);
  }

  updateSettings(name: string, input: TenantSettings): Promise<Result<TenantInfo, MindlogError>> {
    const parsed = tenantSettingsSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve(err(invalid(parsed.error.issues)));
    const { redaction, auditRetentionDays } = parsed.data;
    return this.#patch(name, [
      ...(redaction ? ['redaction', JSON.stringify(redaction)] : []),
      ...(auditRetentionDays ? ['auditRetentionDays', String(auditRetentionDays)] : []),
    ]);
  }

  async policies(name: string): Promise<Result<readonly PolicyRow[], MindlogError>> {
    const read = await this.#read(name);
    if (!read.ok) return read;
    return read.value ? ok(read.value.policies) : err(this.#missing(name));
  }

  async setPolicies(
    name: string,
    input: unknown,
  ): Promise<Result<readonly PolicyRow[], MindlogError>> {
    const parsed = policiesSchema.safeParse(input);
    if (!parsed.success) return err(invalid(parsed.error.issues));
    const saved = await this.#patch(name, ['policies', JSON.stringify(parsed.data.policies)]);
    return saved.ok ? ok(parsed.data.policies as readonly PolicyRow[]) : saved;
  }

  /** Marks a tenant as being deleted: its requests are refused from now on. */
  async markDeleting(name: string): Promise<Result<TenantInfo, MindlogError>> {
    const current = await this.get(name);
    if (!current.ok) return current;
    if (current.value.status !== 'active') return ok(current.value);
    return this.#patch(name, ['status', 'deleting', 'deletingAt', String(this.deps.clock.now())]);
  }

  /** Records that every row of the tenant is gone. The name stays taken. */
  markDeleted(name: string): Promise<Result<TenantInfo, MindlogError>> {
    return this.#patch(name, ['status', 'deleted']);
  }

  /** Stores the state of the tenant's latest export. */
  async setExport(name: string, state: ExportState): Promise<Result<void, MindlogError>> {
    const saved = await this.#patch(name, ['export', JSON.stringify(state)]);
    return saved.ok ? ok(undefined) : saved;
  }

  async exportState(name: string): Promise<Result<ExportState | undefined, MindlogError>> {
    const reply = await this.#run(this.#session(), 'HGET', rowKey(name), 'export');
    if (!reply.ok) return reply;
    const [text] = strings(reply.value);
    return ok(text ? (JSON.parse(text) as ExportState) : undefined);
  }
}
