import type { Clock } from '@mindlog/core';
import { MindlogErrorCode } from '@mindlog/core';
import type { KvCommandRegistry } from '@mindlog/kv';
import { KvReadExecutor, isWrite, replies } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { CommandStamper, Proposer } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import type { StaticAuthenticator } from '../auth/static-authenticator.js';
import { Session } from '../session/session.js';

export interface KvServiceDeps {
  readonly registry: KvCommandRegistry;
  /** Applied state, for reads and WATCH versions. */
  readonly store: KvReader;
  readonly proposer: Proposer;
  readonly stamper: CommandStamper;
  readonly clock: Clock;
  readonly authenticator: StaticAuthenticator;
  /** Tenant for sessions until multi-tenancy lands (phase 10). */
  readonly defaultTenant?: string;
}

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

  constructor(deps: KvServiceDeps) {
    this.deps = deps;
    this.reads = new KvReadExecutor(deps.registry, deps.store);
  }

  openSession(id: string): Session {
    return new Session(id, this.deps.defaultTenant ?? 'default', !this.deps.authenticator.required);
  }

  /** AUTH (and HELLO ... AUTH): checks the static user and marks the session. */
  authenticate(session: Session, username: string, password: string): KvReply {
    if (!this.deps.authenticator.required) {
      return replies.error(
        'INVALID_ARGUMENT',
        'AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
      );
    }
    if (!this.deps.authenticator.verify(username, password)) {
      return replies.error(
        'INVALID_CREDENTIALS',
        'invalid username-password pair or user is disabled.',
      );
    }
    session.authenticated = true;
    session.principal = username;
    return replies.ok();
  }

  async execute(session: Session, argv: readonly Uint8Array[]): Promise<KvReply> {
    const name = commandName(argv);
    if (!session.authenticated && !OPEN_COMMANDS.has(name)) {
      return replies.error('UNAUTHENTICATED', 'Authentication required.');
    }
    if (name === 'AUTH') return this.#auth(session, argv);
    return this.run(session, argv);
  }

  /** Runs one data command: reads on applied state, writes through the Proposer. */
  protected async run(session: Session, argv: readonly Uint8Array[]): Promise<KvReply> {
    const command = argv[0] ? this.deps.registry.get(argv[0]) : undefined;
    if (!command || !isWrite(command)) {
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

  #auth(session: Session, argv: readonly Uint8Array[]): KvReply {
    if (argv.length === 2) return this.authenticate(session, 'default', decoder.decode(argv[1]));
    if (argv.length === 3) {
      return this.authenticate(session, decoder.decode(argv[1]), decoder.decode(argv[2]));
    }
    return replies.errors.arity('auth');
  }
}
