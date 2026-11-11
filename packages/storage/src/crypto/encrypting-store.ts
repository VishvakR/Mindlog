import { randomBytes } from 'node:crypto';
import type { KeyRange, MindlogError, Result } from '@mindlog/core';
import {
  NODE_TENANT,
  decodeKey,
  encodeKey,
  err,
  keyPrefix,
  mindlogError,
  ok,
  prefixRange,
} from '@mindlog/core';
import { compareBytes } from '../store/compare-bytes.js';
import type {
  Entry,
  IterateOptions,
  KvReader,
  KvStore,
  StoreSnapshot,
  WriteBatch,
} from '../store/kv-store.js';
import { envelopeKeyId, seal, unseal } from './envelope.js';

/** A data key: one per scope (a tenant, or this node's own state) per node. */
interface DataKey {
  readonly id: number;
  readonly scope: string;
  readonly key: Uint8Array;
  /** The wrapped row stored in the keyring. */
  readonly row: Uint8Array;
  /** Whether a batch holding the keyring row has been written. */
  durable: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MARKER_TEXT = encoder.encode('mindlog encryption v1');
const KEY_BYTES = 32;

function systemKey(tuple: (string | bigint)[]): Uint8Array {
  const key = encodeKey({ tenant: NODE_TENANT, family: 's', tuple });
  if (!key.ok) throw new RangeError(key.error.message);
  return key.value;
}

/** Rows the decorator owns: kept in plaintext form (wrapped), and hidden from readers. */
const internal = (() => {
  const prefix = keyPrefix(NODE_TENANT, 's', ['crypto']);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefixRange(prefix.value);
})();
const markerKey = systemKey(['crypto', 'marker']);
const keyringKey = (id: number) => systemKey(['crypto', 'key', BigInt(id)]);
const keyringRange = prefixRange(systemKey(['crypto', 'key']));

const isInternal = (key: Uint8Array): boolean =>
  compareBytes(key, internal.start) >= 0 && compareBytes(key, internal.end) < 0;

/** The tenant a key belongs to; anything that does not decode is this node's own state. */
function scopeOf(key: Uint8Array): string {
  const decoded = decodeKey(key);
  return decoded.ok ? decoded.value.tenant : NODE_TENANT;
}

/** Keyring payload: `scope length (u16) · scope · key`, wrapped by the master key. */
function wrap(master: Uint8Array, id: number, scope: string, key: Uint8Array): Uint8Array {
  const name = encoder.encode(scope);
  const payload = new Uint8Array(2 + name.length + key.length);
  new DataView(payload.buffer).setUint16(0, name.length);
  payload.set(name, 2);
  payload.set(key, 2 + name.length);
  return seal(0, master, keyringKey(id), payload);
}

function unwrap(master: Uint8Array, id: number, row: Uint8Array): DataKey {
  const payload = unseal(master, keyringKey(id), row);
  const length = new DataView(payload.buffer, payload.byteOffset).getUint16(0);
  return {
    id,
    scope: decoder.decode(payload.subarray(2, 2 + length)),
    key: payload.slice(2 + length),
    row,
    durable: true,
  };
}

const refuse = (message: string): MindlogError => mindlogError('CONFIG_INVALID', message);

/**
 * Encryption at rest (PLAN 10.6, ADR-0014): every value is sealed with
 * AES-256-GCM under its tenant's data key, with the key bytes as associated
 * data so a value cannot be moved to another key. Keys stay plaintext, so
 * ordering, ranges and splits work unchanged. Data keys are per node, wrapped
 * by the master key in a keyring kept in the same store.
 */
export class EncryptingStore implements KvStore {
  readonly #byId = new Map<number, DataKey>();
  readonly #byScope = new Map<string, DataKey>();
  #nextId = 1;

  private constructor(
    private readonly inner: KvStore,
    private readonly master: Uint8Array,
  ) {}

  /**
   * Opens an encrypted store, or makes a new empty one encrypted. A store
   * that holds plaintext data, or was encrypted with another master key, is
   * refused; without a master key an encrypted store is refused too.
   */
  static async open(
    inner: KvStore,
    master: Uint8Array | undefined,
    name: string,
  ): Promise<Result<KvStore, MindlogError>> {
    const marker = await inner.get(markerKey);
    if (!master)
      return marker
        ? err(refuse(`the ${name} store is encrypted; configure storage.encryption.masterKey`))
        : ok(inner);
    if (master.length !== KEY_BYTES) return err(refuse('the master key must be 32 bytes'));
    const store = new EncryptingStore(inner, master);
    if (marker) {
      try {
        unseal(master, markerKey, marker);
      } catch {
        return err(refuse(`the ${name} store was encrypted with another master key`));
      }
      for await (const [key, row] of inner.iterate(keyringRange)) {
        const decoded = decodeKey(key);
        const id = decoded.ok ? decoded.value.tuple[2] : undefined;
        if (typeof id !== 'bigint') throw new Error('malformed keyring row');
        store.#remember(unwrap(master, Number(id), row));
      }
      return ok(store);
    }
    for await (const _ of inner.iterate(
      { start: new Uint8Array(), end: Uint8Array.of(0xff) },
      { limit: 1 },
    ))
      return err(
        refuse(`the ${name} store holds unencrypted data; encryption needs a new data directory`),
      );
    const batch = inner.batch();
    batch.put(markerKey, seal(0, master, markerKey, MARKER_TEXT));
    await batch.write({ sync: true });
    return ok(store);
  }

  #remember(k: DataKey): void {
    this.#byId.set(k.id, k);
    const current = this.#byScope.get(k.scope);
    if (!current || current.id < k.id) this.#byScope.set(k.scope, k);
    this.#nextId = Math.max(this.#nextId, k.id + 1);
  }

  #keyFor(scope: string): DataKey {
    const existing = this.#byScope.get(scope);
    if (existing) return existing;
    const id = this.#nextId;
    const key = new Uint8Array(randomBytes(KEY_BYTES));
    const made: DataKey = {
      id,
      scope,
      key,
      row: wrap(this.master, id, scope, key),
      durable: false,
    };
    this.#remember(made);
    return made;
  }

  #open(key: Uint8Array, sealed: Uint8Array): Uint8Array {
    const id = envelopeKeyId(sealed);
    const k = this.#byId.get(id);
    // A missing key means the tenant was shredded or the keyring is damaged: never guess.
    if (!k) throw new Error(`no data key ${String(id)} for a stored value`);
    return unseal(k.key, key, sealed);
  }

  /** Scopes holding a data key here, for tenant deletion. */
  scopes(): string[] {
    return [...this.#byScope.keys()];
  }

  /**
   * Destroys every data key of a scope (crypto-shredding): values sealed with
   * them can never be read again. Call only once the scope has no keys left.
   */
  async forget(scope: string): Promise<void> {
    const batch = this.inner.batch();
    for (const k of [...this.#byId.values()].filter((d) => d.scope === scope)) {
      batch.del(keyringKey(k.id));
      this.#byId.delete(k.id);
    }
    this.#byScope.delete(scope);
    await batch.write({ sync: true });
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    if (isInternal(key)) return undefined;
    const sealed = await this.inner.get(key);
    return sealed === undefined ? undefined : this.#open(key, sealed);
  }

  iterate(range: KeyRange, options?: IterateOptions): AsyncIterable<Entry> {
    return decrypting(this.inner, range, options, (k, v) => this.#open(k, v));
  }

  async snapshot(): Promise<StoreSnapshot> {
    const inner = await this.inner.snapshot();
    const open = (k: Uint8Array, v: Uint8Array) => this.#open(k, v);
    return {
      get: async (key) => {
        if (isInternal(key)) return undefined;
        const sealed = await inner.get(key);
        return sealed === undefined ? undefined : open(key, sealed);
      },
      iterate: (range, options) => decrypting(inner, range, options, open),
      release: () => inner.release(),
    };
  }

  batch(): WriteBatch {
    const inner = this.inner.batch();
    const created: DataKey[] = [];
    let length = 0;
    return {
      put: (key, value) => {
        if (isInternal(key)) throw new Error('encryption rows are not writable');
        const k = this.#keyFor(scopeOf(key));
        // The keyring row rides in every batch until one with it is written, so no value
        // can ever be durable without the key that opens it.
        if (!k.durable && !created.includes(k)) {
          inner.put(keyringKey(k.id), k.row);
          created.push(k);
        }
        inner.put(key, seal(k.id, k.key, key, value));
        length++;
      },
      del: (key) => {
        inner.del(key);
        length++;
      },
      get length() {
        return length;
      },
      write: async (options) => {
        await inner.write(options);
        for (const k of created) k.durable = true;
      },
    };
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

function decrypting(
  inner: KvReader,
  range: KeyRange,
  options: IterateOptions | undefined,
  open: (key: Uint8Array, sealed: Uint8Array) => Uint8Array,
): AsyncIterable<Entry> {
  return {
    async *[Symbol.asyncIterator]() {
      let left = options?.limit ?? Infinity;
      if (left <= 0) return;
      const { limit: _limit, ...rest } = options ?? {};
      for await (const [key, sealed] of inner.iterate(range, rest)) {
        if (isInternal(key)) continue;
        yield [key, open(key, sealed)] as const;
        if (--left <= 0) return;
      }
    },
  };
}

/** Re-wraps a store's keyring under a new master key, offline (`keys rotate-master`). */
export async function rewrapKeyring(
  inner: KvStore,
  oldMaster: Uint8Array,
  newMaster: Uint8Array,
): Promise<Result<number, MindlogError>> {
  const marker = await inner.get(markerKey);
  if (!marker) return err(refuse('the store is not encrypted'));
  try {
    unseal(oldMaster, markerKey, marker);
  } catch {
    return err(refuse('the old master key does not open this store'));
  }
  const batch = inner.batch();
  let count = 0;
  for await (const [key, row] of inner.iterate(keyringRange)) {
    const decoded = decodeKey(key);
    const id = decoded.ok ? decoded.value.tuple[2] : undefined;
    if (typeof id !== 'bigint') throw new Error('malformed keyring row');
    const k = unwrap(oldMaster, Number(id), row);
    batch.put(key, wrap(newMaster, k.id, k.scope, k.key));
    count++;
  }
  batch.put(markerKey, seal(0, newMaster, markerKey, MARKER_TEXT));
  await batch.write({ sync: true });
  return ok(count);
}
