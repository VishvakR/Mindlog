import { headerKey } from './kv-keys.js';

/** Anything that can report a key's newest version index (MvccReader or MvccTxn). */
export interface VersionSource {
  latestIndex(key: Uint8Array): Promise<bigint>;
}

/**
 * The WATCH version of a Redis key: the commit index of its header's newest
 * change, deletes included (0 if never written). EXEC aborts if it moved.
 */
export function watchVersion(
  source: VersionSource,
  tenant: string,
  name: Uint8Array,
): Promise<bigint> {
  return source.latestIndex(headerKey(tenant, name));
}
