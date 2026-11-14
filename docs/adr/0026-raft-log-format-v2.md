# ADR-0026: Raft log format v2, snapshots and data-directory format markers

- Status: accepted
- Date: 2026-10-16
- PLAN: 5.1 (key encoding), 7.3 (persistence rules), 10.3 (snapshots), 21 (failure handling)
- References: etcd-raft.md, hashicorp-raft.md, classic-level.md
- Amends: ADR-0005 (keys of the log store)

## Context

The phase 1 log stored CRC-framed `Command`s with no term, and only a "last truncated index". Raft needs the term of each entry, a durable hard state (term, vote, commit), entry types (normal, configuration change, empty no-op) and snapshot metadata. Old data directories cannot be read as Raft logs. The only existing data is development data.

## Decision

**Log store (`raftlog/`)**, all keys in the `$node` tenant, family `s`:
- `('raftlog', rangeId, index)` → CRC32C (4 bytes, big-endian) + `mindlog.v1.Entry {term, index, type, data}`. A normal entry's `data` is a `Command`; an empty `data` is the leader's no-op; a `CONF_CHANGE` entry holds a `ConfChange`.
- `('raft-state', rangeId)` → CRC32C + `HardState {term, vote, commit}`.
- `('raft-truncated', rangeId)` → CRC32C + `TruncatedState {index, term}`: the last entry removed by compaction (or replaced by a snapshot), so an empty log still knows its last index and term.
- Every Ready cycle writes entries (deleting any conflicting suffix), hard state and truncated state in **one batch with `sync: true`**, before any message of that cycle is sent.

**State store (`state/`)**:
- `('applied', rangeId)` → `{index, term}` (16 bytes): the term is new, so a restarted node can check its state against its log.
- `('conf-state', rangeId)` → `ConfState {voters, learners, addresses}`, written in the same batch as the apply that changed it (ADR-0006).

**Format markers**: both stores hold `('format',)` → `2`. On open, a store with data but no marker, or another version, makes the node exit with `CONFIG_INVALID` and a message to wipe the data directory (no migration; phase 1–2 data was development data). Empty stores get the marker on first open.

**Snapshots** (single range per store in phase 3):
- A snapshot is the state store's contents at its applied index, read from a consistent `StoreSnapshot`, plus `SnapshotMeta {index, term, conf_state}` built from the same view.
- The receiver collects the chunks in memory, then installs them as **one atomic LevelDB batch** (`sync: true`) that deletes every old state key and writes every new one, including `applied` and `conf-state`. Then it rewrites the log store (drop all entries, `raft-truncated = {index, term}`, hard state) in a second synced batch.
- `shortcut: snapshot data is held in memory on both sides and installed as one batch; ranges are capped at ranges.maxBytes (64 MiB), so this holds; stage to disk if that cap grows.`
- **Boot reconciliation** handles a crash between the two batches. If the state store's applied `{A, termA}` is beyond the log (`A > lastIndex`), or the log's entry at `A` has a different term, the log is reset to `raft-truncated = {A, termA}` with no entries. This is safe: if the local entry at `A` differs from the committed one, no later local entry can be committed (log matching). If `A` is below the truncated index, the node refuses to start (CLAUDE.md rule 7 was broken).

**Compaction**: when `applied − firstIndex > raft.snapshotEntries` (or the log exceeds `raft.snapshotBytes`), the replica flushes the state store with `sync: true`, then removes entries up to `applied − raft.trailingEntries` and records their truncated state. Trailing entries let slightly-behind followers catch up from the log instead of a snapshot (pattern from hashicorp/raft).

## Alternatives considered

- **Migrate old directories**: more code and tests for development data only.
- **Install-pending marker with in-place writes**: a crash mid-install leaves state that is neither old nor new; recovering needs either a log wipe (unsafe, the node may have acknowledged entries) or a snapshot request path. The single atomic batch avoids both.
- **Directory swap** (`state.new/` then rename): crash-safe for any size, but every holder of the state store would need a swappable handle. Revisit when snapshots outgrow memory.

## Consequences

- `StateMachine.apply` takes the entry term as well as the index; no-op and configuration entries advance the applied index too.
- Restart replays committed entries above the applied index from the log (unchanged from ADR-0005).
- The simulator's disk model (unsynced batches lost on power loss) checks the two-batch install and the reconciliation path.
