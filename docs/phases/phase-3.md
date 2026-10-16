# Phase 3 — Raft consensus and deterministic simulation: exit-gate evidence

- Date: 2026-10-16
- PLAN: §24 Phase 3
- Status: **gate met**, awaiting sign-off
- Decisions:
  - ADR-0006: single-server membership changes.
  - ADR-0007: leases and clock assumptions.
  - ADR-0025: Connect transport.
  - ADR-0026: log format v2 and snapshots.
  - ADR-0005 was amended.

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| 10,000 simulator seeds with random faults pass all invariants | `scripts/sim.sh 10000 6`: seeds 1–10,000 (3 and 5 nodes alternating) passed every invariant in 28.5 min on 6 shards. The first full run found 5 failing seeds, all the same liveness bug (see Defects); they are now regression seeds in `test/sim/regressions.ts` | ✔ |
| Maelstrom `lin-kv` reports valid under partitions | `test/maelstrom/run.sh` (`lin-kv`, 3 nodes, concurrency 2n, 60 s, rate 100, `--nemesis partition`) printed `:valid? true` and "Everything looks good!": 3,541 ok, 1,569 definite failures (cas mismatches, no leader), 6 indefinite | ✔ |
| Failover < 3 s measured | `test/integration/failover.test.ts` runs 3 real processes with writers on every node, then SIGKILLs the leader. 30 kills: median 1.53 s, p90 1.75 s, max 1.85 s. A final 10-kill run: max 1.62 s. No acknowledged write was lost: the counter is at least the number of acknowledged INCRs and at most that plus the indefinite ones | ✔ |

**Deliverable** (3-node cluster; kill the leader during `redis-benchmark`; writes resume):
- `docker compose --profile chaos up` started three containers.
- `redis-benchmark -t set,incr -c 20` ran against a follower.
- `scripts/chaos/kill-leader.sh` SIGKILLed the leader (`mindlog-3`).
- `mindlog-2` was leader 2 s later. The benchmark kept going, and the restarted node rejoined.
- Throughput was 700–950 writes/s with three containers fsyncing in Docker Desktop.
- The stack was then taken down with `docker compose --profile chaos down`.

## What the simulator checks

`test/sim` runs real replicas, state machines and KV services in one process (PLAN 22.2).

Faults:
- **Network:** latency 0.5–20 ms with reordering, loss up to 10%, 2% duplication, and random partitions.
- **Disk:** the model keeps unsynced writes after a kill and loses a random suffix of them on power loss. The last write can tear.
- **Clocks:** each node's rate drifts by up to ±5%.
- **Cluster:** 3 or 5 nodes.

Workload: 4 clients doing GET, SET and `SET … IFEQ` on 3 keys for 20 s. Then 30 s of healing, and final linearizable reads.

Checks after every event:
- one leader per term;
- one command per log index on every replica;
- `applied ≤ commit ≤ last`.

Checks at the end:
- a leader exists and every replica applied the same index;
- the state store hashes are equal;
- each key's history is linearizable (a Wing–Gong check in `test/sim/linearizability.ts`).

Self-checks:
- A seed replays to identical results (`a seed replays exactly`).
- Two planted bugs are caught: a lease that is always valid (stale reads, so the history is not linearizable) and log writes without fsync (state machine safety violations after power loss).

## Phase 3 checklist (PLAN 24)

| Task | Where |
|---|---|
| Pure Raft core (roles, PreVote, CheckQuorum, fast backtracking, commit rule, Ready, ReadIndex, lease, snapshots, compaction, learners, single-server changes, transfer, flow control) | `packages/raft` (46 tests: etcd paper and interaction scenarios as outcome assertions, quorum and inflight properties, 200-seed core chaos; 10,000 seeds checked once) |
| Raft log store on its own LevelDB, group commit, CRC32C | `RaftLogStore` (`packages/statemachine`), one synced batch per Ready; contract suite over MemoryStore and LevelDB |
| gRPC streaming transport, batching, snapshot chunks | `packages/transport` (Connect on HTTP/2, ADR-0025) |
| Raft behind the `Proposer` port; follower forwarding | `Replica` (`packages/multiraft`); `--single-node` is a one-voter range; `CLUSTER.*` admin commands |
| Read paths: linearizable, lease, bounded staleness | `Replica.read(level)` behind the services `ReadBarrier` port (ADR-0007) |
| Simulator with SimNetwork, SimDisk, SimClock, SimRandom; DSL; invariants; seed replay | `test/sim` (`scenario(seed).nodes(5).faults({...}).for(ms).run()`), `pnpm sim`, `scripts/sim.sh` |
| Maelstrom adapter, `lin-kv` with partitions | `mindlog-maelstrom` (`packages/server/src/maelstrom`), `test/maelstrom/run.sh` (Docker) |
| Chaos compose profile, kill and partition scripts | `docker-compose.yml` `chaos`, `scripts/chaos/` |
| ADR-005, ADR-006, ADR-007 | ADR-0005 amended; ADR-0006, ADR-0007; plus ADR-0025, ADR-0026 |

## Other checks run

| Check | Command | Result |
|---|---|---|
| Lint, typecheck, tests | `pnpm lint`, `pnpm typecheck`, `pnpm test` | ✔ 97 files, 795 tests + web 7 |
| Coverage | `pnpm test:coverage` | Statements 91.3%, branches 83.4%, functions 93.5%, lines 94.3% |
| Phase 1 and 2 gates still hold | `pnpm test:durability`; `pnpm fuzz:resp`; `scripts/bench-smoke.sh 100000 50`; `uv run pytest compat -m compat`; dashboard round-trip and trace tests | ✔ 50 kills (6,340 acknowledged writes of each kind, all present); 3 fuzz targets; benchmark SET 10.3k–14.4k/s and GET 27k–34k/s depending on laptop load; redis-py 23/23 |
| Python | ruff, mypy --strict, pytest | ✔ 32 tests |
| Protobuf | `pnpm proto:lint`, `pnpm proto:breaking` | ✔ |
| Commits | `pnpm lint:commits` | ✔ (warnings only, on old phase 0–1 commits) |

## Defects found while building

| Found by | Defect | Fix |
|---|---|---|
| Test helpers hanging on startup | Conf-change validation required an address, so a single node's bootstrap entry was silently ignored | Addresses are checked by `CLUSTER.ADDLEARNER`, not by the deterministic apply rule |
| Membership test | A node that joins later never learned the initial membership, which came from config | Initial members are committed `ADD_VOTER` entries (`bootstrapEntries`), as etcd does |
| Core chaos test, seed 11 | A leader stayed in `snapshot` state forever when the follower's reply was lost | `reportSnapshot` from the host, plus a probe again after `2 × electionTicks.max` |
| Replica test | A transfer target got `TimeoutNow` before it applied its own promotion, so it could not campaign | The leader repeats `TimeoutNow` on heartbeat responses |
| Failover measurement (4 s) | A write forwarded to a leader that died waited for its 4 s deadline | Pending proposals are proposed again on a leader change; apply deduplicates by request id |
| Simulator, seeds 1229, 4039, 5313, 7115, 9139 | Lost appends filled the leader's inflight window, so a follower stopped catching up | A heartbeat response frees one slot (as etcd did); the seeds are regression tests |
| Maelstrom smoke run | Maelstrom names nodes from `n0`, but Raft ids must be non-zero | `nK` maps to Raft id K+1 |

## Known gaps and follow-ups

- **Existing data directories:** phase 1–2 directories are refused (ADR-0026). The `dev` compose volume from phase 2 must be removed with `docker volume rm mindlog_mindlog-data`, and the superuser created again.
- **Failover time:** with the PLAN 7.4 timings, a tied election costs a second election timeout, so one failover in about 20 can approach 3 s. The measured maximum over 30 kills was 1.85 s.
- **Lease overhead:** single-node `GET` is about 13% slower than in phase 2 (32.7k/s vs 37.4k/s) because of the lease check per read. `SET` is unchanged (14.4k/s).
- **Throughput:**
  - The leader proposes one entry per Ready under sequential clients.
  - A restarted follower catches up at roughly the write rate.
  - Batching across ranges and proposals is phase 4 and phase 11 work.
- **Not built in phase 3:**
  - joint consensus (ADR-0006 stretch);
  - async storage writes;
  - TLS certificates for the internal port (phase 10);
  - a dashboard cluster page;
  - `iptables`/`tc` partitions (the scripts disconnect Docker networks instead);
  - multi-range work (phase 4).
- **Snapshots** are held in memory on both sides and installed as one batch (`shortcut:` in ADR-0026); this is fine while ranges stay at or below 64 MiB.
