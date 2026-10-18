import { SystemRandom } from '@mindlog/core';
import type { KvReply } from '@mindlog/proto';
import type { KvReader } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import { isWrite } from '../commands/kv-command.js';
import type { KvCommandRegistry } from '../commands/registry.js';
import { Keyspace } from '../model/keyspace.js';
import type { KvView } from '../model/kv-view.js';
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

  /** Runs a read; `at` reads the snapshot as of that MVCC version instead of the latest state. */
  execute(
    tenant: string,
    argv: readonly Uint8Array[],
    nowMs: bigint,
    at?: bigint,
  ): Promise<KvReply> {
    const command = argv[0] ? this.#registry.get(argv[0]) : undefined;
    if (command && isWrite(command)) {
      return Promise.resolve(error('INTERNAL', `${command.name} must be proposed, not read`));
    }
    const keyspace = new Keyspace({
      tenant,
      nowMs,
      view: at === undefined ? this.#view : atVersion(this.#view, at),
      version: 0n,
      random: this.#random,
    });
    return this.#registry.dispatch(keyspace, argv);
  }
}

/** A view that sees only versions at or below `at`. */
const atVersion = (view: MvccReader, at: bigint): KvView => ({
  get: async (key) => (await view.getVersioned(key, at))?.value,
  scan: (prefix, options) => view.scan(prefix, { ...options, at }),
});
