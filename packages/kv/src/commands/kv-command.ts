import type { KvReply } from '@mindlog/proto';
import type { Keyspace } from '../model/keyspace.js';

export type CommandFlag = 'write' | 'readonly' | 'fast' | 'denyoom';

/** Positions of key arguments in argv (1-based, Valkey `key_specs` range form). */
export interface KeyPositions {
  readonly first: number;
  /** Last key position; negative counts from the end (-1 = last argument). */
  readonly last: number;
  readonly step: number;
}

/**
 * One Redis command. `arity` follows Redis: positive means exactly that many
 * arguments including the name, negative means at least |arity|. Write
 * commands run only inside apply; read-only commands run on applied state.
 */
export interface KvCommand {
  readonly name: string;
  readonly arity: number;
  readonly flags: readonly CommandFlag[];
  /** Omitted for commands without key arguments. */
  readonly keys?: KeyPositions;
  execute(keyspace: Keyspace, args: readonly Uint8Array[]): Promise<KvReply>;
}

export const isWrite = (command: KvCommand): boolean => command.flags.includes('write');
