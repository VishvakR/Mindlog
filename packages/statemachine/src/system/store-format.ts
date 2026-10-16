import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import { WHOLE_STORE, formatKey } from './system-keys.js';

/** Current on-disk format of the log and state stores (ADR-0026). */
export const STORE_FORMAT = 2;

/**
 * Stamps an empty store with the current format, or checks a used one. A store
 * with data but another (or no) format is refused: phase 1–2 directories are
 * not migrated.
 */
export async function ensureStoreFormat(
  store: KvStore,
  name: string,
): Promise<Result<void, MindlogError>> {
  const stored = await store.get(formatKey());
  if (stored) {
    const version = stored.length === 1 ? stored[0] : undefined;
    if (version === STORE_FORMAT) return ok(undefined);
    return err(formatError(name, `format ${version ?? 'unknown'}`));
  }
  for await (const _ of store.iterate(WHOLE_STORE, { limit: 1 })) {
    return err(formatError(name, 'a pre-Raft format'));
  }
  const batch = store.batch();
  batch.put(formatKey(), Uint8Array.of(STORE_FORMAT));
  await batch.write({ sync: true });
  return ok(undefined);
}

const formatError = (name: string, found: string): MindlogError =>
  mindlogError(
    'CONFIG_INVALID',
    `the ${name} store has ${found}, but this version needs format ${STORE_FORMAT} (ADR-0026); wipe the data directory to start fresh`,
  );
