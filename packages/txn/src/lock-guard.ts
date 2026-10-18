import type { WriteGuard } from '@mindlog/kv';
import { errorResult } from '@mindlog/statemachine';
import { readLock } from './lock-store.js';

/**
 * Refuses a plain write to a key a transaction has locked. The write is not
 * applied, so the client may simply retry once the lock is resolved.
 */
export const lockGuard: WriteGuard = async (context, keys) => {
  for (const key of keys) {
    if (await readLock(context.raw.reader, context.descriptor.rangeId, context.command.tenant, key))
      return errorResult('UNAVAILABLE', 'the key is locked by a transaction; retry');
  }
  return undefined;
};
