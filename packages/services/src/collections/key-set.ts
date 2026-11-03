import { randomBytes } from 'node:crypto';
import type { MindlogError, Result } from '@mindlog/core';
import { SYSTEM_TENANT, err, mindlogError, ok } from '@mindlog/core';
import type { KvService } from '../kv/kv-service.js';
import { Session } from '../session/session.js';
import { strings, toRecord } from '../admin/kv-strings.js';

const KEY = 'settings:jwt';
const encoder = new TextEncoder();

/**
 * JWT signing keys (ADR-0035) in the system tenant, replicated like the
 * superusers' secret: `current` names the signing key, older keys still
 * verify until they are removed.
 */
export class JwtKeySet {
  #keys: { current: string; secrets: Map<string, string> } | undefined;

  constructor(private readonly service: KvService) {}

  async #run(...args: string[]): Promise<Result<string[], MindlogError>> {
    const session = new Session('jwt', SYSTEM_TENANT, true);
    session.principal = 'system:auth';
    const reply = await this.service.execute(
      session,
      args.map((a) => encoder.encode(a)),
    );
    if (reply.kind.case === 'error') {
      return err(
        mindlogError(reply.kind.value.code as MindlogError['code'], reply.kind.value.message),
      );
    }
    return ok(strings(reply));
  }

  async #load(): Promise<Result<{ current: string; secrets: Map<string, string> }, MindlogError>> {
    if (this.#keys) return ok(this.#keys);
    // HSETNX twice: nodes racing on first use agree on one key id, then on one secret for it.
    const named = await this.#run('HSETNX', KEY, 'current', randomBytes(6).toString('hex'));
    if (!named.ok) return named;
    const kid = await this.#run('HGET', KEY, 'current');
    if (!kid.ok) return kid;
    const secret = await this.#run(
      'HSETNX',
      KEY,
      `k:${kid.value[0] ?? ''}`,
      randomBytes(32).toString('base64url'),
    );
    if (!secret.ok) return secret;
    const all = await this.#run('HGETALL', KEY);
    if (!all.ok) return all;
    const record = toRecord(all.value);
    const secrets = new Map(
      Object.entries(record)
        .filter(([k]) => k.startsWith('k:'))
        .map(([k, v]) => [k.slice(2), v]),
    );
    const current = record['current'] ?? '';
    if (!secrets.has(current))
      return err(mindlogError('UNAVAILABLE', 'the signing key is being created; retry'));
    this.#keys = { current, secrets };
    return ok(this.#keys);
  }

  async current(): Promise<Result<{ kid: string; secret: string }, MindlogError>> {
    const keys = await this.#load();
    if (!keys.ok) return keys;
    return ok({
      kid: keys.value.current,
      secret: keys.value.secrets.get(keys.value.current) ?? '',
    });
  }

  async secret(kid: string): Promise<string | undefined> {
    const keys = await this.#load();
    if (keys.ok && !keys.value.secrets.has(kid)) {
      // Another node may have rotated since this one loaded the keys.
      this.#keys = undefined;
      const again = await this.#load();
      return again.ok ? again.value.secrets.get(kid) : undefined;
    }
    return keys.ok ? keys.value.secrets.get(kid) : undefined;
  }

  /** Adds a key and signs with it from now on; old tokens keep verifying. */
  async rotate(): Promise<Result<string, MindlogError>> {
    const kid = randomBytes(6).toString('hex');
    const set = await this.#run(
      'HSET',
      KEY,
      `k:${kid}`,
      randomBytes(32).toString('base64url'),
      'current',
      kid,
    );
    this.#keys = undefined;
    return set.ok ? ok(kid) : set;
  }
}
