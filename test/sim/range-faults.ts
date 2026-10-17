import { create } from '@bufbuild/protobuf';
import type { Replica, Store } from '@mindlog/multiraft';
import { ConfChangeSchema, ConfChangeType } from '@mindlog/proto';
import { compareBytes } from '@mindlog/storage';
import type { World } from './world.js';

/** Range-level faults (PLAN 24 phase 4): splits, merges, leader transfers, membership churn. */
export interface RangeFaultTarget {
  readonly world: World;
  /** Stores of nodes that are up now. */
  readonly live: () => Store[];
  readonly say: (line: string) => void;
  readonly nextRangeId: () => bigint;
  readonly count: (kind: 'splits' | 'merges' | 'transfers' | 'membership') => void;
}

const leaders = (store: Store): Replica[] =>
  store.replicas().filter((r) => r.isLeader() && r.initialised);

function pickLeader(t: RangeFaultTarget): [Store, Replica] | undefined {
  const pairs = t.live().flatMap((s) => leaders(s).map((r) => [s, r] as [Store, Replica]));
  return pairs.length === 0 ? undefined : t.world.pick(pairs);
}

export function splitSomeRange(t: RangeFaultTarget): void {
  const picked = pickLeader(t);
  if (!picked) return;
  const [store, replica] = picked;
  const id = t.nextRangeId();
  t.count('splits');
  t.say(`split range ${replica.rangeId} into ${id}`);
  void store.split(replica.rangeId, id).then((r) => {
    if (!r.ok) t.say(`split ${replica.rangeId} failed: ${r.error.code} ${r.error.message}`);
  });
}

/** Merges a range whose leader's node also holds its left neighbour. */
export function mergeSomeRanges(t: RangeFaultTarget): void {
  const candidates = t.live().flatMap((store) =>
    leaders(store).flatMap((right) => {
      const left = store
        .replicas()
        .find(
          (l) =>
            l.initialised &&
            l.descriptor.endKey.length > 0 &&
            compareBytes(l.descriptor.endKey, right.descriptor.startKey) === 0,
        );
      return left ? [[store, left, right] as const] : [];
    }),
  );
  if (candidates.length === 0) return;
  const [store, left, right] = t.world.pick(candidates);
  t.count('merges');
  t.say(`merge range ${right.rangeId} into ${left.rangeId}`);
  void store.merge(left.rangeId).then((r) => {
    if (!r.ok) t.say(`merge into ${left.rangeId} failed: ${r.error.code}`);
  });
}

export function transferSomeLeader(t: RangeFaultTarget): void {
  const picked = pickLeader(t);
  if (!picked) return;
  const [, replica] = picked;
  const s = replica.status();
  const others = s.confState.voters.filter((id) => id !== s.id);
  if (others.length === 0) return;
  const to = t.world.pick(others);
  t.count('transfers');
  t.say(`transfer range ${replica.rangeId} to n${to}`);
  replica.transferLeader(to);
}

/** Removes a voter from a range, then adds it back as a learner and promotes it. */
export function churnSomeMember(t: RangeFaultTarget): void {
  const picked = pickLeader(t);
  if (!picked) return;
  const [, replica] = picked;
  const s = replica.status();
  const others = s.confState.voters.filter((id) => id !== s.id);
  if (others.length < 2) return;
  const victim = t.world.pick(others);
  const rangeId = replica.rangeId;
  t.count('membership');
  t.say(`remove n${victim} from range ${rangeId}`);
  const change = (type: ConfChangeType) =>
    create(ConfChangeSchema, { type, nodeId: victim, address: `n${victim}` });
  const leaderOf = () =>
    t
      .live()
      .flatMap((st) => leaders(st))
      .find((r) => r.rangeId === rangeId);
  void replica.changeMembership(change(ConfChangeType.REMOVE_NODE)).then(() => {
    t.world.at(t.world.now + t.world.between(200, 1500), () => {
      const now = leaderOf();
      if (!now) return;
      t.say(`add n${victim} back to range ${rangeId}`);
      void now.changeMembership(change(ConfChangeType.ADD_LEARNER)).then((added) => {
        if (!added.ok) return;
        t.world.at(t.world.now + t.world.between(200, 1500), () => {
          void leaderOf()?.changeMembership(change(ConfChangeType.ADD_VOTER));
        });
      });
    });
  });
}
