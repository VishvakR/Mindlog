import type { MvccScanOptions, VersionedValue } from '@mindlog/storage';

/** Read access to the latest state (an MvccReader, or an MvccTxn inside apply). */
export interface KvView {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  scan(prefix: Uint8Array, options?: MvccScanOptions): AsyncIterable<VersionedValue>;
}

/** Write access, only available inside apply (an MvccTxn). */
export interface KvWriter {
  put(key: Uint8Array, value: Uint8Array): void;
  delete(key: Uint8Array): void;
}
