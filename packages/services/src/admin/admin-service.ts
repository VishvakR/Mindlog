import { randomBytes } from 'node:crypto';
import type { Clock, MindlogError, Result } from '@mindlog/core';
import { SYSTEM_TENANT, err, mindlogError, ok } from '@mindlog/core';
import type { KvReply } from '@mindlog/proto';
import type { KvService } from '../kv/kv-service.js';
import { Session } from '../session/session.js';
import { hasValidSignature, readClaims, signToken } from './auth-token.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password-hash.js';
import { strings, toRecord } from './kv-strings.js';
import type { AuthResult, Superuser, SuperuserCredentials } from './schemas.js';
import { superuserCredentialsSchema } from './schemas.js';

export interface AdminServiceDeps {
  readonly service: KvService;
  readonly clock: Clock;
  /** Token lifetime; default one day. */
  readonly tokenTtlMs?: number;
}

const DAY_MS = 86_400_000;
const SETTINGS_KEY = 'settings:auth';
const userKey = (email: string) => `superuser:${email}`;
const encoder = new TextEncoder();
const invalid = () => mindlogError('INVALID_CREDENTIALS', 'Invalid email or password.');
const unauthenticated = () => mindlogError('UNAUTHENTICATED', 'Missing or invalid auth token.');

/**
 * Dashboard superusers (ADR-0024): hashes in the system tenant written through
 * the normal proposal path, scrypt passwords and HMAC bearer tokens.
 */
export class AdminService {
  #secret: string | undefined;

  constructor(private readonly deps: AdminServiceDeps) {}

  #session(): Session {
    const session = new Session('admin', SYSTEM_TENANT, true);
    session.principal = 'system:admin';
    return session;
  }

  async #run(session: Session, ...args: string[]): Promise<Result<KvReply, MindlogError>> {
    const reply = await this.deps.service.execute(
      session,
      args.map((a) => encoder.encode(a)),
    );
    if (reply.kind.case === 'error') {
      return err(
        mindlogError(reply.kind.value.code as MindlogError['code'], reply.kind.value.message),
      );
    }
    return ok(reply);
  }

  async #hash(key: string): Promise<Result<Record<string, string>, MindlogError>> {
    const reply = await this.#run(this.#session(), 'HGETALL', key);
    return reply.ok ? ok(toRecord(strings(reply.value))) : reply;
  }

  /** The node-wide signing secret, created on first use (random before proposing). */
  async #authSecret(): Promise<Result<string, MindlogError>> {
    if (this.#secret) return ok(this.#secret);
    const session = this.#session();
    const created = await this.#run(
      session,
      'HSETNX',
      SETTINGS_KEY,
      'secret',
      randomBytes(32).toString('base64url'),
    );
    if (!created.ok) return created;
    const secret = await this.#run(session, 'HGET', SETTINGS_KEY, 'secret');
    if (!secret.ok) return secret;
    this.#secret = strings(secret.value)[0];
    return this.#secret ? ok(this.#secret) : err(mindlogError('INTERNAL', 'auth secret missing'));
  }

  #superuser(record: Record<string, string>): Superuser {
    const iso = (ms: string | undefined) => new Date(Number(ms ?? 0)).toISOString();
    return {
      email: record.email ?? '',
      created: iso(record.created),
      updated: iso(record.updated),
    };
  }

  /** Creates a superuser or resets its password; a reset revokes its tokens. */
  async upsertSuperuser(input: SuperuserCredentials): Promise<Result<Superuser, MindlogError>> {
    const parsed = superuserCredentialsSchema.safeParse(input);
    if (!parsed.success) {
      const fields = Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join('.'), i.message]),
      );
      return err(mindlogError('INVALID_ARGUMENT', 'Invalid superuser credentials.', { fields }));
    }
    const { email, password } = parsed.data;
    const secret = await this.#authSecret();
    if (!secret.ok) return secret;
    const now = String(this.deps.clock.now());
    const session = this.#session();
    for (const args of [
      ['MULTI'],
      ['HSETNX', userKey(email), 'created', now],
      [
        'HSET',
        userKey(email),
        'email',
        email,
        'passwordHash',
        await hashPassword(password),
        'tokenKey',
        randomBytes(24).toString('base64url'),
        'updated',
        now,
      ],
      ['EXEC'],
    ]) {
      const reply = await this.#run(session, ...args);
      if (!reply.ok) return reply;
    }
    const record = await this.#hash(userKey(email));
    return record.ok ? ok(this.#superuser(record.value)) : record;
  }

  /** True once at least one superuser exists. */
  async hasSuperusers(): Promise<Result<boolean, MindlogError>> {
    const session = this.#session();
    let cursor = '0';
    do {
      const page = await this.#run(
        session,
        'SCAN',
        cursor,
        'MATCH',
        'superuser:*',
        'COUNT',
        '1000',
      );
      if (!page.ok) return page;
      const [next = '0', ...keys] = strings(page.value);
      if (keys.length > 0) return ok(true);
      cursor = next;
    } while (cursor !== '0');
    return ok(false);
  }

  async authWithPassword(
    email: string,
    password: string,
  ): Promise<Result<AuthResult, MindlogError>> {
    const record = await this.#hash(userKey(email.trim().toLowerCase()));
    if (!record.ok) return record;
    const hash = record.value.passwordHash;
    const valid = await verifyPassword(password, hash ?? DUMMY_HASH);
    if (!hash || !valid || !record.value.tokenKey) return err(invalid());
    const secret = await this.#authSecret();
    if (!secret.ok) return secret;
    const superuser = this.#superuser(record.value);
    const exp = Number(this.deps.clock.now()) + (this.deps.tokenTtlMs ?? DAY_MS);
    const token = signToken({ sub: superuser.email, exp }, secret.value + record.value.tokenKey);
    return ok({ token, superuser });
  }

  /** The superuser a bearer token belongs to; UNAUTHENTICATED when invalid or expired. */
  async verifyToken(token: string): Promise<Result<Superuser, MindlogError>> {
    const claims = readClaims(token);
    if (!claims || claims.exp <= Number(this.deps.clock.now())) return err(unauthenticated());
    const record = await this.#hash(userKey(claims.sub));
    if (!record.ok) return record;
    const secret = await this.#authSecret();
    if (!secret.ok) return secret;
    const tokenKey = record.value.tokenKey;
    if (!tokenKey || !hasValidSignature(token, secret.value + tokenKey))
      return err(unauthenticated());
    return ok(this.#superuser(record.value));
  }
}
