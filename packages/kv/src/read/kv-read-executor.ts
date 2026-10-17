import { SystemRandom } from '@mindlog/core';
import type { KvReply } from '@mindlog/proto';
import type { KvReader } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import { isWrite } from '../commands/kv-command.js';
import type { KvCommandRegistry } from '../commands/registry.js';
import { Keyspace } from '../model/keyspace.js';
import { error } from '../model/replies.js';

/**
 * Runs read-only commands against the latest applied state. Writes must go
 * through the Proposer; sending one here is a programmer error, reported as
 * an INTERNAL reply rather than executed.
 */
export class KvReadExecutor {
  readonly #registry: KvCommandRegistry;
  readonly #view: MvccReader;
  readonly #random = new SystemRandom();

  constructor(registry: KvCommandRegistry, reader: KvReader) {
    this.#registry = registry;
    this.#view = new MvccReader(reader);
  }

  execute(tenant: string, argv: readonly Uint8Array[], nowMs: bigint): Promise<KvReply> {
    const command = argv[0] ? this.#registry.get(argv[0]) : undefined;
    if (command && isWrite(command)) {
      return Promise.resolve(error('INTERNAL', `${command.name} must be proposed, not read`));
    }
    const keyspace = new Keyspace({
      tenant,
      nowMs,
      view: this.#view,
      version: 0n,
      random: this.#random,
    });
    return this.#registry.dispatch(keyspace, argv);
  }
}
