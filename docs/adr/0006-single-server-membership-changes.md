# ADR-0006: Single-server membership changes before joint consensus

- Status: accepted
- Date: 2026-10-16
- PLAN: 7.1 (learners, membership changes, leadership transfer), 8.6 (node lifecycle)
- References: [raft-thesis.md](../references/raft-thesis.md), [etcd-raft.md](../references/etcd-raft.md), [hashicorp-raft.md](../references/hashicorp-raft.md)

## Context

A range must add, remove and replace replicas without losing safety. Raft offers two schemes. Joint consensus can change any number of voters at once but needs two-phase configurations and quorum math over both. Single-server changes add or remove one voter at a time and are safe because any majority of the old and new configurations overlap. A known pitfall (Ongaro, raft-dev 2015) is that a new leader must commit an entry of its own term before it starts a change. Followers that join empty must catch up before they count towards a quorum.

## Decision

- Membership changes are **one server at a time**. `ConfChange` (proto `mindlog.v1.ConfChange`) has three types: `ADD_LEARNER`, `ADD_VOTER` (adds a voter, or promotes a learner) and `REMOVE_NODE`. Each carries the node's internal address, so the address book is replicated with the configuration.
- New replicas join as **learners**: they receive the log and snapshots but do not vote or count towards commit. An operator (phase 3: `MINDLOG.CLUSTER PROMOTE`; phase 4: the placement driver) promotes them once caught up.
- A configuration takes effect **when the entry is applied**, as in etcd. The leader refuses a new change while `pendingConfIndex > applied`, and sets `pendingConfIndex = lastIndex` when it becomes leader. Because it also appends a no-op entry on election, no change starts before an entry of the leader's term has committed.
- A node does not campaign while a committed configuration change is still unapplied.
- The applied `ConfState` (voters, learners, addresses) is stored in the state store in the same batch as the applied index, and travels inside snapshots.
- Removing the leader is allowed: after it applies its own removal it steps down; leadership transfer (`TimeoutNow` to a caught-up voter) is the graceful path.
- Joint consensus stays a stretch goal; the proto leaves room for it (`ConfChange` can grow a `repeated` form).

## Alternatives considered

- **Joint consensus now**: needed only to change several voters atomically (e.g. swap two zones at once). It doubles the quorum code and its tests for a case phase 3–4 does not need.
- **Effect on append** (dissertation, hashicorp/raft): a truncated log must then roll the configuration back, which complicates the pure core.

## Consequences

- Replacing a voter takes two changes (add learner → promote, then remove), so it passes through an even-sized configuration briefly; the placement driver must sequence it.
- Simulator scenarios cover add, promote, remove (including the leader) under faults.
