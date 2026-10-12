import type { Clock, Logger, Tracer } from '@mindlog/core';
import type { KvReply } from '@mindlog/proto';
import type { KvService, Session } from '@mindlog/services';
import type { CommandTable } from '../commands/command-table.js';
import type { ClientRegistry, ClientState } from './client-state.js';

/** Facts INFO, HELLO and CONFIG GET report about this server. */
export interface ServerInfo {
  /** Redis API level Mindlog emulates (`redis_version`). */
  readonly redisVersion: string;
  readonly mindlogVersion: string;
  readonly port: number;
  readonly startedAtMs: bigint;
  readonly processId: number;
  /** Read-only CONFIG GET parameters. */
  readonly settings: Readonly<Record<string, string>>;
}

/** Node-wide dependencies shared by every connection. */
export interface ServerContext {
  readonly service: KvService;
  readonly commands: CommandTable;
  readonly clients: ClientRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly info: ServerInfo;
  /** Opens a `resp.command` span per command, the root of RESP traces. */
  readonly tracer?: Tracer;
}

/** What a connection-level command may see and change. */
export interface ConnectionContext {
  readonly server: ServerContext;
  readonly client: ClientState;
  readonly session: Session;
  /** Closes the connection once the current reply is written (QUIT). */
  closeAfterReply(): void;
  /** Fresh session: no transaction, no watches, authentication reset (RESET). */
  resetSession(): void;
}

/**
 * A command answered by the adapter itself because it concerns the connection
 * or the protocol (HELLO, CLIENT, COMMAND, ...). Arity and authentication are
 * checked before `execute`, from the command's JSON spec.
 */
export interface ConnectionCommand {
  readonly name: string;
  execute(ctx: ConnectionContext, argv: readonly Uint8Array[]): KvReply | Promise<KvReply>;
}

/** Connection-level commands by name, case-insensitive. */
export class ConnectionCommandRegistry {
  readonly #commands = new Map<string, ConnectionCommand>();

  constructor(commands: readonly ConnectionCommand[] = []) {
    for (const command of commands) this.register(command);
  }

  register(command: ConnectionCommand): void {
    const name = command.name.toUpperCase();
    if (this.#commands.has(name)) throw new Error(`connection command ${name} registered twice`);
    this.#commands.set(name, command);
  }

  get(name: string): ConnectionCommand | undefined {
    return this.#commands.get(name.toUpperCase());
  }

  names(): string[] {
    return [...this.#commands.keys()];
  }
}
