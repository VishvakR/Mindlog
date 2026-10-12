import type { KvReply } from '@mindlog/proto';
import type { Keyspace } from '../model/keyspace.js';
import { error, errors } from '../model/replies.js';
import type { KvCommand } from './kv-command.js';

const decoder = new TextDecoder();

const commandName = (raw: Uint8Array): string => decoder.decode(raw).toUpperCase();

/** Valkey's message for an unknown command (server.c), args truncated as there. */
function unknownCommand(argv: readonly Uint8Array[]): KvReply {
  const [name, ...rest] = argv.map((a) => decoder.decode(a).slice(0, 128));
  const args = rest.map((a) => `'${a}' `).join('');
  return error(
    'INVALID_ARGUMENT',
    `unknown command '${name ?? ''}', with args beginning with: ${args}`,
  );
}

/** All KV commands by name, case-insensitive. */
export class KvCommandRegistry {
  readonly #commands = new Map<string, KvCommand>();

  register(...commands: KvCommand[]): this {
    for (const command of commands) {
      const name = command.name.toUpperCase();
      if (this.#commands.has(name)) throw new Error(`command ${name} is already registered`);
      this.#commands.set(name, command);
    }
    return this;
  }

  get(name: Uint8Array | string): KvCommand | undefined {
    return this.#commands.get(typeof name === 'string' ? name.toUpperCase() : commandName(name));
  }

  list(): KvCommand[] {
    return [...this.#commands.values()];
  }

  /** Validates name and arity, then executes; errors come back as replies. */
  async dispatch(keyspace: Keyspace, argv: readonly Uint8Array[]): Promise<KvReply> {
    const [raw, ...args] = argv;
    const command = raw ? this.get(raw) : undefined;
    if (!command) return unknownCommand(argv);
    const ok = command.arity >= 0 ? argv.length === command.arity : argv.length >= -command.arity;
    if (!ok) return errors.arity(command.name);
    return command.execute(keyspace, args);
  }
}
