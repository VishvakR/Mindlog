import type { CommandResult } from '@mindlog/proto';
import type { ApplyContext } from '@mindlog/statemachine';
import { errorResult, inSpan } from '@mindlog/statemachine';
import { headerKey } from '../model/kv-keys.js';
import { Keyspace } from '../model/keyspace.js';

/** The keyspace a command sees inside apply: its tenant, its range, its version. */
export function applyKeyspace(context: ApplyContext): Keyspace {
  const { command, txn, version, nowMs, random, descriptor, raw } = context;
  return new Keyspace({
    tenant: command.tenant,
    nowMs,
    view: txn,
    writer: txn,
    version,
    random,
    local: { rangeId: descriptor.rangeId, batch: raw.batch },
  });
}

/** `RANGE_MOVED` unless every key belongs to the applying range (ADR-0029). */
export function outsideRange(
  context: ApplyContext,
  keys: Iterable<Uint8Array>,
): CommandResult | undefined {
  const { command, descriptor } = context;
  for (const key of keys) {
    if (!inSpan(descriptor, headerKey(command.tenant, key)))
      return errorResult('RANGE_MOVED', `key is not in range ${descriptor.rangeId}`);
  }
  return undefined;
}
