# ADR-0013: Memory branches as overlays at a fork version

- Status: accepted
- Date: 2026-10-30
- PLAN: 13.1 (branching memory), 13.3 (ASOF), 6.1 (commands 30–32), 10.2 (MVCC GC), 19.5 (cluster version)
- References: dolt-neon.md, automerge.md, letta.md

## Context

An agent should be able to try a plan on a copy of a user's memory, see it in recall, and then merge it into `main` or drop it, while other agents keep writing to `main`. A user scope lives in one range (ADR-0031), and MVCC versions are HLCs (ADR-0027), so "main as it was when the branch was made" is an ordinary versioned read.

## Decision

- **Metadata**: `m/(user,'B',name)` → `MemoryBranch { name, forkIndex, forkVersion, createdBy, status: open|merged|dropped, closedAt }`, written by `BranchCreate` (body 30). `forkVersion` is the command's version.
- **Branch space**: a branch's own memory keys use main's layout under `m/(user,'w',name, …)` (records, vectors, postings, df, stats, entities, mentions, edges, generation). The apply helpers and `MemoryReads` take a *root* (`user` or `{user, branch}`), so branch writes reuse the same code and have branch-local vector and BM25 indexes.
- **Writes on a branch** are the ordinary `MemoryCommit`, `MemoryForget` and `MemoryTrust` commands with `Command.branch = name`; apply refuses them unless the branch is open. Forgetting or re-trusting a *main* memory on a branch writes a copy of its record (as of the fork) into the branch space with the change, and no index rows: the copy masks main's record in branch reads.
- **Reads on a branch** use an overlay: branch space (latest) over main at `forkVersion`. Records come from the branch first; BM25 stats, df and postings add up; mentions and graph edges are the union; the vector index is built from both spaces' `v` rows. Recall runs its normal stages on the overlay, so masked main memories drop out in the filter stage.
- **Merge** (`BranchMerge`, body 31) is planned on the leader and applied as data:
  1. Branch changes: new branch memories (adds), copies that forget or re-trust main memories, and edge weight deltas (`branch − main at fork`).
  2. Each added fact goes through conflict detection (ADR-0015) against main's current facts.
  3. The pure planner in `@mindlog/branching` applies the policy (`abort`, `raise`, `prefer_branch`, `prefer_main`) and CRDT rules: edge weights are PN-counters (main + delta), sets are add-wins OR-sets, trust and validity are last-writer-wins registers ordered by `(hlc, id)`.
  4. The command carries the plan and the main generation it was computed at. Apply refuses with a retryable `CONFLICT` if main moved, so the plan never applies to state it did not see; the service re-plans.
  5. Apply writes the adds with their original ids through the normal index writes, raises conflicts, marks the branch `merged` and deletes its branch space.
- **Drop** (`BranchDrop`, body 32) marks the branch `dropped` and deletes its branch space.
- **Size**: a branch holds at most `memory.branches.maxMemories` (default 1,000) so merge and drop fit one command.
- **GC pinning**: the KV GC job lowers its `belowVersion` to the oldest `forkVersion` of the range's open branches, so a branch keeps reading main as of its fork.
- Gated by cluster version 7.

## Alternatives considered

- **Copy the scope on branch**: O(scope) work and storage per branch and a large Raft entry; overlays cost nothing until the branch writes.
- **A `branch` field on main's keys**: every main read and index would have to filter it out; a separate space keeps main's code paths unchanged.
- **Separate range per branch**: merges would become cross-range transactions.

## Consequences

- Branch recall builds its vector index on each query (brute force over main at the fork plus the branch), which is fine at our scope sizes; a cached overlay index is the upgrade path.
- Reading main at `forkVersion` relies on MVCC versions; pinning keeps them, at the cost of retaining history while branches stay open.
- `MEM.DIFF` lists the branch's adds, forgets and trust changes from the branch space alone.
- The simulator (`SIM_BRANCH=1`) checks that main never shows unmerged branch writes and that merges leave identical state on every replica.
