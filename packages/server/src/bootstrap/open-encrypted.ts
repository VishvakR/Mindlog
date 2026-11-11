import type { MindlogConfig, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import { EncryptingStore } from '@mindlog/storage';

/** The configured master key (base64 of 32 bytes), or undefined when encryption is off. */
export function masterKeyOf(config: MindlogConfig): Result<Uint8Array | undefined, MindlogError> {
  const text = config.storage.encryption.masterKey;
  if (text === undefined) return ok(undefined);
  const key = new Uint8Array(Buffer.from(text, 'base64'));
  return key.length === 32
    ? ok(key)
    : err(mindlogError('CONFIG_INVALID', 'storage.encryption.masterKey must be 32 bytes, base64'));
}

/** Opens `store` through encryption when a master key is set; checks the data directory either way. */
export function encrypted(
  store: KvStore,
  master: Uint8Array | undefined,
  name: string,
): Promise<Result<KvStore, MindlogError>> {
  return EncryptingStore.open(store, master, name);
}
