import type {
  Clock,
  Counter,
  Histogram,
  Metrics,
  MindlogError,
  Result,
  Tracer,
} from '@mindlog/core';
import { MindlogErrorCode, isUserTenant } from '@mindlog/core';
import type { KvCommandRegistry } from '@mindlog/kv';
import { KvReadExecutor, isWrite, replies, watchVersion } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { CommandStamper, Proposer } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import type { Access } from '@mindlog/auth';
import type { StaticAuthenticator } from '../auth/static-authenticator.js';
import type { Authorize } from '../tenants/authorize.js';
import type { AdmitClass } from '../tenants/governor.js';
import type { ReadBarrier } from './read-barrier.js';
import type { Caller, RangeCall, RangeRouter } from './range-router.js';
import { RoutedKv } from './routed-kv.js';
import { Session } from '../session/session.js';

export interface KvServiceDeps {
  readonly registry: KvCommandRegistry;
  /** Applied state, for reads and WATCH versions. */
  readonly store: KvReader;
  readonly proposer: Proposer;
  /** Gates reads on leadership or freshness (ADR-0007). */
  readonly readBarrier: ReadBarrier;
  readonly stamper: CommandStamper;
  readonly clock: Clock;
  readonly authenticator: StaticAuthenticator;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
  /** Tenant for sessions until multi-tenancy lands (phase 10). */
  readonly defaultTenant?: string;
  /** Commands one MULTI may queue (`limits.maxTransactionCommands`). */
  readonly maxTransactionCommands?: number;
  /**
   * With a router, commands go to the range that holds their keys and `proposer`,
   * `readBarrier` and `store` are not used (ADR-0029); without one this service
   * serves a single range.
   */
  readonly router?: RangeRouter;
  /** Authorizes sessions that an API key authenticated (PLAN 18.2). */
  readonly authorize?: Authorize;
  /** Resolves an `mlk_` API key given to AUTH; the key's tenant becomes the session's. */
  readonly verifyApiKey?: (
    key: string,
  ) => Promise<Result<{ access: Access; tenant: string }, MindlogError>>;
  /** Per-tenant admission (PLAN 18.3). */
  readonly admit?: (tenant: string, cls: AdmitClass) => Promise<Result<void, MindlogError>>;
  /** Takes a tenant's connection slot for a key-bound session. */
  readonly acquireConnection?: (tenant: string) => Promise<Result<() => void, MindlogError>>;
  /** With `router`: lets writes that span ranges run as transactions (`features.crossRangeTxn`, ADR-0030). */
  readonly tso?: () => Promise<Result<bigint, MindlogError>>;
}

const DEFAULT_MAX_TRANSACTION_COMMANDS = 10_000;

const API_KEY_PREFIX = 'mlk_';

/** Allowed at a quota: without them a full tenant could never make room. */
const FREEING = new Set(['DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT']);

const SESSION_COMMANDS = new Set(['AUTH', 'MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH']);

const decoder = new TextDecoder();
export const commandName = (argv: readonly Uint8Array[]): string =>
  argv[0] ? decoder.decode(argv[0]).toUpperCase() : '';

const CODES = new Set<string>(Object.values(MindlogErrorCode));
const knownCode = (code: string): MindlogErrorCode =>
  CODES.has(code) ? (code as MindlogErrorCode) : 'INTERNAL';

/** Commands a session may run before authenticating. */
const OPEN_COMMANDS = new Set(['AUTH']);

/**
 * The KV request path shared by every adapter: authentication, routing reads
 * to applied state and writes through the Proposer, and session-level
 * commands. Adapters only parse and serialise (CLAUDE.md §9).
 */
export class KvService {
  protected readonly deps: KvServiceDeps;
  protected readonly reads: KvReadExecutor;
  readonly #routed: RoutedKv | undefined;
  readonly #latency: Histogram;
  readonly #errors: Counter;

  constructor(deps: KvServiceDeps) {
    this.deps = deps;
    this.reads = new KvReadExecutor(deps.registry, deps.store);
    this.#routed = deps.router
      ? new RoutedKv({
          registry: deps.registry,
          router: deps.router,
          stamper: deps.stamper,
          clock: deps.clock,
          ...(deps.tso ? { tso: deps.tso } : {}),
        })
      : undefined;
    this.#latency = deps.metrics.histogram({
      name: 'mindlog_kv_command_latency_seconds',
      help: 'KV command latency as seen by the service, by command',
      labelNames: ['command'],
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    });
    this.#errors = deps.metrics.counter({
      name: 'mindlog_kv_command_errors_total',
      help: 'KV commands answered with an error, by command and error code',
      labelNames: ['command', 'code'],
    });
  }

  /** Bounded label for metrics: known command names only. */
  #label(name: string): string {
    return SESSION_COMMANDS.has(name) || this.deps.registry.get(name)
      ? name.toLowerCase()
      : 'unknown';
  }

  openSession(id: string): Session {
    return new Session(id, this.deps.defaultTenant ?? 'default', !this.deps.authenticator.required);
  }

  /** Whether sessions start unauthenticated (a password is configured). */
  get authenticationRequired(): boolean {
    return this.deps.authenticator.required;
  }

  /**
   * AUTH <user> <pass> and HELLO ... AUTH: checks the static user and marks the
   * session. Without a password the `default` user is `nopass`, as in Valkey.
   * An `mlk_` API key in the password position binds the session to the key's
   * tenant and role instead.
   */
  async authenticate(session: Session, username: string, password: string): Promise<KvReply> {
    if (password.startsWith(API_KEY_PREFIX) && this.deps.verifyApiKey) {
      const verified = await this.deps.verifyApiKey(password);
      if (!verified.ok) return replies.error('INVALID_CREDENTIALS', 'invalid API key.');
      const slot = this.deps.acquireConnection
        ? await this.deps.acquireConnection(verified.value.tenant)
        : undefined;
      if (slot && !slot.ok) return replies.error(slot.error.code, slot.error.message);
      session.release?.();
      session.release = slot?.value;
      session.resetTransaction();
      session.tenant = verified.value.tenant;
      session.access = verified.value.access;
      session.principal = verified.value.access.subject;
      session.authenticated = true;
      return replies.ok();
    }
    const required = this.deps.authenticator.required;
    const valid = required
      ? this.deps.authenticator.verify(username, password)
      : username === 'default';
    if (!valid) {
      return replies.error(
        'INVALID_CREDENTIALS',
        'invalid username-password pair or user is disabled.',
      );
    }
    session.release?.();
    session.release = undefined;
    session.resetTransaction();
    session.tenant = this.deps.defaultTenant ?? 'default';
    session.access = undefined;
    session.authenticated = true;
    session.principal = username;
    return replies.ok();
  }

  /** Executes one command with a span, a latency observation and error counting. */
  async execute(session: Session, argv: readonly Uint8Array[]): Promise<KvReply> {
    const label = this.#label(commandName(argv));
    const started = this.deps.clock.monotonic();
    const reply = await this.deps.tracer.withSpan(
      `kv.${label}`,
      { 'mindlog.tenant': session.tenant, 'mindlog.command': label },
      () => this.#dispatch(session, argv),
    );
    this.#latency.observe(Number(this.deps.clock.monotonic() - started) / 1e9, { command: label });
    if (reply.kind.case === 'error')
      this.#errors.inc(1, { command: label, code: reply.kind.value.code });
    return reply;
  }

  async #dispatch(session: Session, argv: readonly Uint8Array[]): Promise<KvReply> {
    const name = commandName(argv);
    if (!session.authenticated && !OPEN_COMMANDS.has(name)) {
      return replies.error('UNAUTHENTICATED', 'Authentication required.');
    }
    if (name === 'AUTH') return this.#auth(session, argv);
    const denied = await this.#denied(session, argv);
    if (denied) return denied;
    const refused = await this.#refused(session, name, argv);
    if (refused) return refused;
    switch (name) {
      case 'MULTI':
        return this.#multi(session, argv);
      case 'EXEC':
        return this.#exec(session, argv);
      case 'DISCARD':
        return this.#discard(session, argv);
      case 'WATCH':
        return this.#watch(session, argv);
      case 'UNWATCH':
        session.watches.clear();
        return replies.ok();
    }
    if (session.transaction) return this.#queue(session, argv);
    return this.run(session, argv);
  }

  /** The refusal for a session limited by an API key, if this command is outside its role. */
  async #denied(session: Session, argv: readonly Uint8Array[]): Promise<KvReply | undefined> {
    if (!session.access) return undefined;
    const name = commandName(argv);
    const command = argv[0] ? this.deps.registry.get(argv[0]) : undefined;
    if (!command && name !== 'WATCH') return undefined;
    if (!this.deps.authorize) return replies.error('PERMISSION_DENIED', 'authorization is off');
    const action = command && isWrite(command) ? 'kv.write' : 'kv.read';
    const allowed = await this.deps.authorize(session.access, action, { tenant: session.tenant });
    return allowed.ok ? undefined : replies.error(allowed.error.code, allowed.error.message);
  }

  /** The refusal when the session's tenant is over a write limit. Reads have no KV limit. */
  async #refused(
    session: Session,
    name: string,
    argv: readonly Uint8Array[],
  ): Promise<KvReply | undefined> {
    if (!this.deps.admit || !isUserTenant(session.tenant)) return undefined;
    const command = argv[0] ? this.deps.registry.get(argv[0]) : undefined;
    if (!command || !isWrite(command)) return undefined;
    const admitted = await this.deps.admit(session.tenant, FREEING.has(name) ? 'free' : 'write');
    return admitted.ok ? undefined : replies.error(admitted.error.code, admitted.error.message);
  }

  #multi(session: Session, argv: readonly Uint8Array[]): KvReply {
    if (argv.length !== 1) return replies.errors.arity('multi');
    if (session.transaction)
      return replies.error('INVALID_ARGUMENT', 'MULTI calls can not be nested');
    session.transaction = { queued: [], failed: false };
    return replies.ok();
  }

  /** Validates a command at queue time; a bad one aborts the whole EXEC (Valkey). */
  #queue(session: Session, argv: readonly Uint8Array[]): KvReply {
    const transaction = session.transaction;
    if (!transaction) return replies.error('INTERNAL', 'no transaction');
    const command = argv[0] ? this.deps.registry.get(argv[0]) : undefined;
    let problem: KvReply | undefined;
    if (!command) {
      const [head, ...rest] = argv.map((a) => decoder.decode(a).slice(0, 128));
      const args = rest.map((a) => `'${a}' `).join('');
      problem = replies.error(
        'INVALID_ARGUMENT',
        `unknown command '${head ?? ''}', with args beginning with: ${args}`,
      );
    } else if (command.arity >= 0 ? argv.length !== command.arity : argv.length < -command.arity) {
      problem = replies.errors.arity(command.name);
    } else {
      const limit = this.deps.maxTransactionCommands ?? DEFAULT_MAX_TRANSACTION_COMMANDS;
      if (transaction.queued.length >= limit) {
        problem = replies.error(
          'PAYLOAD_TOO_LARGE',
          `Transaction has too many commands (limit ${String(limit)})`,
        );
      }
    }
    if (problem) {
      transaction.failed = true;
      return problem;
    }
    transaction.queued.push(argv.map((a) => a.slice()));
    return replies.simple('QUEUED');
  }

  async #exec(session: Session, argv: readonly Uint8Array[]): Promise<KvReply> {
    if (argv.length !== 1) return replies.errors.arity('exec');
    const transaction = session.transaction;
    if (!transaction) return replies.error('INVALID_ARGUMENT', 'EXEC without MULTI');
    const watches = [...session.watches.values()];
    session.resetTransaction();
    if (transaction.failed) {
      return replies.error('EXEC_ABORTED', 'Transaction discarded because of previous errors.');
    }
    if (this.#routed) return this.#routed.batch(this.#caller(session), transaction.queued, watches);
    return this.propose(session, {
      case: 'kvBatch',
      value: { writes: transaction.queued.map((a) => ({ argv: a })), watches },
    });
  }

  #discard(session: Session, argv: readonly Uint8Array[]): KvReply {
    if (argv.length !== 1) return replies.errors.arity('discard');
    if (!session.transaction) return replies.error('INVALID_ARGUMENT', 'DISCARD without MULTI');
    session.resetTransaction();
    return replies.ok();
  }

  async #watch(session: Session, argv: readonly Uint8Array[]): Promise<KvReply> {
    if (argv.length < 2) return replies.errors.arity('watch');
    if (session.transaction)
      return replies.error('INVALID_ARGUMENT', 'WATCH inside MULTI is not allowed');
    if (this.#routed) {
      const keys = argv.slice(1);
      const versions = await this.#routed.versions(this.#caller(session), keys);
      if (!versions.ok) return replies.error(versions.error.code, versions.error.message);
      keys.forEach((key, i) => {
        const id = Buffer.from(key).toString('hex');
        if (!session.watches.has(id))
          session.watches.set(id, { key: key.slice(), version: versions.value[i] ?? 0n });
      });
      return replies.ok();
    }
    // WATCH versions must be current: EXEC compares them at commit (PLAN 9.3).
    const ready = await this.deps.readBarrier.read('linearizable');
    if (!ready.ok) return replies.error(ready.error.code, ready.error.message);
    const reader = new MvccReader(this.deps.store);
    for (const key of argv.slice(1)) {
      const id = Buffer.from(key).toString('hex');
      if (!session.watches.has(id)) {
        session.watches.set(id, {
          key: key.slice(),
          version: await watchVersion(reader, session.tenant, key),
        });
      }
    }
    return replies.ok();
  }

  /** Runs one data command: reads on applied state, writes through the Proposer. */
  protected async run(session: Session, argv: readonly Uint8Array[]): Promise<KvReply> {
    const command = argv[0] ? this.deps.registry.get(argv[0]) : undefined;
    if (!command) return this.reads.execute(session.tenant, argv, this.deps.clock.now());
    if (this.#routed) return this.#routed.command(this.#caller(session), argv);
    if (!isWrite(command)) {
      const ready = await this.deps.readBarrier.read('lease');
      if (!ready.ok) return replies.error(ready.error.code, ready.error.message);
      return this.reads.execute(session.tenant, argv, this.deps.clock.now());
    }
    const ok = command.arity >= 0 ? argv.length === command.arity : argv.length >= -command.arity;
    if (!ok) return replies.errors.arity(command.name);
    return this.propose(session, { case: 'kvWrite', value: { argv: [...argv] } });
  }

  protected async propose(
    session: Session,
    body: Parameters<CommandStamper['stamp']>[2],
  ): Promise<KvReply> {
    const command = this.deps.stamper.stamp(session.tenant, session.principal, body);
    const proposal = await this.deps.proposer.propose(command);
    if (!proposal.ok) return replies.error(proposal.error.code, proposal.error.message);
    const outcome = proposal.value.result.outcome;
    if (outcome.case === 'kv') return outcome.value;
    if (outcome.case === 'error')
      return replies.error(knownCode(outcome.value.code), outcome.value.message);
    return replies.error('INTERNAL', 'empty command result');
  }

  #caller(session: Session): { tenant: string; principal: string } {
    return { tenant: session.tenant, principal: session.principal };
  }

  /** Resolves a transaction lock this node found (the lock-resolver job's step). */
  resolveLock(
    tenant: string,
    key: Uint8Array,
    primary: Uint8Array,
    startTs: bigint,
  ): Promise<void> {
    return this.#routed?.resolveLock(tenant, key, primary, startTs) ?? Promise.resolve();
  }

  /** Runs a call that another node forwarded here for a range this node holds (ADR-0029). */
  forwarded(rangeId: bigint, caller: Caller, call: RangeCall): Promise<KvReply> {
    if (!this.#routed)
      return Promise.resolve(replies.error('UNAVAILABLE', 'this service has no router'));
    return this.#routed.forwarded(rangeId, caller, call);
  }

  async #auth(session: Session, argv: readonly Uint8Array[]): Promise<KvReply> {
    if (argv.length === 2) {
      const secret = decoder.decode(argv[1]);
      if (secret.startsWith(API_KEY_PREFIX) && this.deps.verifyApiKey)
        return this.authenticate(session, 'default', secret);
      if (!this.deps.authenticator.required) {
        return replies.error(
          'INVALID_ARGUMENT',
          'AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
        );
      }
      return this.authenticate(session, 'default', decoder.decode(argv[1]));
    }
    if (argv.length === 3) {
      return this.authenticate(session, decoder.decode(argv[1]), decoder.decode(argv[2]));
    }
    return replies.errors.arity('auth');
  }
}
