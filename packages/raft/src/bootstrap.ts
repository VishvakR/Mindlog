import { create, toBinary } from '@bufbuild/protobuf';
import type { Entry } from '@mindlog/proto';
import { ConfChangeSchema, ConfChangeType, EntrySchema, EntryType } from '@mindlog/proto';

export interface BootstrapPeer {
  readonly id: bigint;
  readonly address: string;
}

/**
 * The first log entries of a brand-new range: one committed ADD_VOTER per
 * initial peer at term 1 (as etcd's Bootstrap). Every initial node writes the
 * same entries, so membership always comes from the log or a snapshot, and a
 * node that joins later learns it by replaying them.
 */
export function bootstrapEntries(peers: readonly BootstrapPeer[]): Entry[] {
  return [...peers]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((peer, i) =>
      create(EntrySchema, {
        term: 1n,
        index: BigInt(i + 1),
        type: EntryType.CONF_CHANGE,
        data: toBinary(
          ConfChangeSchema,
          create(ConfChangeSchema, {
            type: ConfChangeType.ADD_VOTER,
            nodeId: peer.id,
            address: peer.address,
          }),
        ),
      }),
    );
}
