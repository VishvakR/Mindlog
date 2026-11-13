import { create, toBinary } from '@bufbuild/protobuf';
import type { KeyValue } from '@mindlog/proto';
import { ConfStateSchema } from '@mindlog/proto';
import { confStateKey, rangeLocalPrefix } from '../system/system-keys.js';

const startsWith = (key: Uint8Array, prefix: Uint8Array): boolean =>
  key.length >= prefix.length && Buffer.compare(key.subarray(0, prefix.length), prefix) === 0;

/**
 * A range snapshot's pairs with `replicaId` as its only voter (ADR-0041): what
 * a restore onto a fresh node installs, so the node elects itself. The removed-
 * replica records of the old cluster go too; ids are never reused.
 */
export function soleVoter(
  rangeId: bigint,
  replicaId: bigint,
  pairs: readonly KeyValue[],
): KeyValue[] {
  const conf = confStateKey(rangeId);
  const removed = rangeLocalPrefix(rangeId, 'removed');
  const value = toBinary(
    ConfStateSchema,
    create(ConfStateSchema, { voters: [replicaId], addresses: { [replicaId.toString()]: '' } }),
  );
  return pairs
    .filter((p) => !startsWith(p.key, removed))
    .map((p) => (Buffer.compare(p.key, conf) === 0 ? { ...p, value } : p));
}
