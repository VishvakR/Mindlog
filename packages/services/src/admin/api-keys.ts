import { createHash, randomBytes } from 'node:crypto';
import type { Clock, MindlogError, Result } from '@mindlog/core';
import { SYSTEM_TENANT, err, isUserTenant, mindlogError, ok } from '@mindlog/core';
import type { KvReply } from '@mindlog/proto';
import { z } from 'zod';
import type { KvService } from '../kv/kv-service.js';
import { Session } from '../session/session.js';
import { tenantRoleSchema } from '../tenants/schemas.js';
import type { TenantRole } from '../tenants/schemas.js';
import { strings, toRecord } from './kv-strings.js';

export const apiKeyInputSchema = z.strictObject({
  tenant: z.string().min(1).max(128).refine(isUserTenant, 'reserved tenant'),
  /** Pins the key to one user scope; absent means every user of the tenant. */
  user: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(128),
  /** What the key may do (PLAN 18.2); agents unless stated. */
  role: tenantRoleSchema.default('agent'),
  /** Memory scope patterns the key is limited to, such as `team-*`. */
  scopes: z.array(z.string().min(1).max(128)).min(1).max(64).optional(),
  /** Milliseconds since the epoch after which the key stops working. */
  expiresAt: z.number().int().positive().optional(),
});

export type ApiKeyInput = z.input<typeof apiKeyInputSchema>;

/** Who an API key speaks for, and what it may do (PLAN 18.2). */
export interface ApiKeyIdentity {
  readonly id: string;
  readonly tenant: string;
  readonly user?: string;
  readonly name: string;
  readonly role: TenantRole;
  readonly scopes?: string[];
  readonly expiresAt?: number;
}

export interface ApiKeyInfo extends ApiKeyIdentity {
  readonly created: string;
}

const PREFIX = 'mlk_';
const INDEX = 'apikeys';
const recordKey = (id: string) => `apikey:${id}`;
const encoder = new TextEncoder();
/** The stored id: the SHA-256 of the key, so a leaked state store does not leak keys. */
const idOf = (key: string): string => createHash('sha256').update(key).digest('hex');
const unauthenticated = () => mindlogError('UNAUTHENTICATED', 'Missing or invalid API key.');

/** Whether a key may act on a user scope of its tenant. */
export function authorizeScope(key: ApiKeyIdentity, user: string): Result<void, MindlogError> {
  if (key.user === undefined || key.user === user) return ok(undefined);
  return err(mindlogError('PERMISSION_DENIED', `this API key is limited to user ${key.user}`));
}

/**
 * API keys for agents (PLAN 15.2): hashed records in the system tenant written
 * through the normal proposal path, like the superusers (ADR-0024).
 */
export class ApiKeyService {
  constructor(private readonly deps: { readonly service: KvService; readonly clock: Clock }) {}

  #session(): Session {
    const session = new Session('apikeys', SYSTEM_TENANT, true);
    session.principal = 'system:apikeys';
    return session;
  }

  async #run(...args: string[]): Promise<Result<KvReply, MindlogError>> {
    return this.#runIn(this.#session(), ...args);
  }

  async #runIn(session: Session, ...args: string[]): Promise<Result<KvReply, MindlogError>> {
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

  async #record(id: string): Promise<Result<Record<string, string>, MindlogError>> {
    const reply = await this.#run('HGETALL', recordKey(id));
    return reply.ok ? ok(toRecord(strings(reply.value))) : reply;
  }

  #identity(id: string, r: Record<string, string>): ApiKeyInfo {
    return {
      id: id.slice(0, 16),
      tenant: r.tenant ?? '',
      ...(r.user ? { user: r.user } : {}),
      name: r.name ?? '',
      // Keys made before roles existed have none and act as agents.
      role: (r.role ?? 'agent') as TenantRole,
      ...(r.scopes ? { scopes: JSON.parse(r.scopes) as string[] } : {}),
      ...(r.expiresAt ? { expiresAt: Number(r.expiresAt) } : {}),
      created: new Date(Number(r.created ?? 0)).toISOString(),
    };
  }

  /** Creates a key; the returned `key` is the only time the secret is shown. */
  async create(input: ApiKeyInput): Promise<Result<ApiKeyInfo & { key: string }, MindlogError>> {
    const parsed = apiKeyInputSchema.safeParse(input);
    if (!parsed.success)
      return err(
        mindlogError('INVALID_ARGUMENT', 'Invalid API key.', {
          fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])),
        }),
      );
    const { tenant, user, name, role, scopes, expiresAt } = parsed.data;
    const extras = {
      role,
      ...(scopes ? { scopes: JSON.stringify(scopes) } : {}),
      ...(expiresAt ? { expiresAt: String(expiresAt) } : {}),
    };
    const key = PREFIX + randomBytes(32).toString('base64url');
    const id = idOf(key);
    const created = String(this.deps.clock.now());
    const session = this.#session();
    for (const args of [
      ['MULTI'],
      [
        'HSET',
        recordKey(id),
        'tenant',
        tenant,
        'name',
        name,
        'created',
        created,
        ...(user ? ['user', user] : []),
        ...Object.entries(extras).flat(),
      ],
      ['SADD', INDEX, id],
      ['EXEC'],
    ]) {
      const reply = await this.#runIn(session, ...args);
      if (!reply.ok) return reply;
    }
    const row = { tenant, name, created, ...(user ? { user } : {}), ...extras };
    return ok({ ...this.#identity(id, row), key });
  }

  async verify(key: string): Promise<Result<ApiKeyIdentity, MindlogError>> {
    if (!key.startsWith(PREFIX)) return err(unauthenticated());
    const id = idOf(key);
    const record = await this.#record(id);
    if (!record.ok) return record;
    // Looked up by the key's hash: an unknown or revoked key has no record.
    if (!record.value.tenant) return err(unauthenticated());
    const { created: _created, ...identity } = this.#identity(id, record.value);
    if (identity.expiresAt !== undefined && identity.expiresAt <= Number(this.deps.clock.now()))
      return err(unauthenticated());
    return ok(identity);
  }

  /** Keys of one tenant, or all of them. */
  async list(tenant?: string): Promise<Result<ApiKeyInfo[], MindlogError>> {
    const ids = await this.#run('SMEMBERS', INDEX);
    if (!ids.ok) return ids;
    const out: ApiKeyInfo[] = [];
    for (const id of strings(ids.value).sort()) {
      const record = await this.#record(id);
      if (!record.ok) return record;
      if (record.value.tenant && (tenant === undefined || record.value.tenant === tenant))
        out.push(this.#identity(id, record.value));
    }
    return ok(out);
  }

  /** Revokes the key whose listed id is `id`, within `tenant` if given; false when there is none. */
  async revoke(id: string, tenant?: string): Promise<Result<boolean, MindlogError>> {
    const ids = await this.#run('SMEMBERS', INDEX);
    if (!ids.ok) return ids;
    const full = strings(ids.value).find((h) => h.slice(0, 16) === id);
    if (!full || id.length < 16) return ok(false);
    if (tenant !== undefined) {
      const record = await this.#record(full);
      if (!record.ok) return record;
      if (record.value.tenant !== tenant) return ok(false);
    }
    const session = this.#session();
    for (const args of [['MULTI'], ['DEL', recordKey(full)], ['SREM', INDEX, full], ['EXEC']]) {
      const reply = await this.#runIn(session, ...args);
      if (!reply.ok) return reply;
    }
    return ok(true);
  }
}
