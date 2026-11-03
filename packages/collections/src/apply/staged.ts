import type { MvccTxn } from '@mindlog/storage';

/**
 * Writes held back until every check of a command passed: apply flushes the
 * transaction even for an error result, so a half-validated command would
 * otherwise leave partial writes. Reads see the staged writes.
 */
export class Staged {
  readonly #writes = new Map<string, { key: Uint8Array; value: Uint8Array | null }>();

  constructor(private readonly txn: MvccTxn) {}

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    const staged = this.#writes.get(hex(key));
    if (staged !== undefined) return staged.value ?? undefined;
    return this.txn.get(key);
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.#writes.set(hex(key), { key, value });
  }

  delete(key: Uint8Array): void {
    this.#writes.set(hex(key), { key, value: null });
  }

  /** Committed keys under a prefix (staged writes are not merged in). */
  scan(prefix: Uint8Array): ReturnType<MvccTxn['scan']> {
    return this.txn.scan(prefix);
  }

  flush(): void {
    for (const { key, value } of this.#writes.values()) {
      if (value === null) this.txn.delete(key);
      else this.txn.put(key, value);
    }
    this.#writes.clear();
  }
}

const hex = (key: Uint8Array): string =>
  Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('hex');
