# Phase 1 — Single-node storage, KV and RESP3: exit-gate evidence

- Date: 2026-10-12
- PLAN: §24 Phase 1
- Status: **gate met**, awaiting sign-off
- Commits: 101 since phase 0 (`3d4cb02..HEAD`), one per component, each with its tests

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| Compatibility subset passes | `test/compat/ioredis.test.ts`: ioredis 6.0.0 (negotiates RESP3 with `HELLO 3`) against an in-process node: strings, binary values, expiry, SCAN, hashes, lists, sets, sorted sets, JSON, errors, pipelines, MULTI/EXEC/WATCH, AUTH. `python/compat/test_redis_py.py`: redis-py 8.1.0 against the built server, every test in RESP2 and RESP3. Reply shapes were compared with Redis 7.2.4 where clients differ by protocol | ✔ ioredis 15/15; redis-py 23/23 |
| `redis-benchmark -t set,get,incr,lpush,hset,zadd` completes | `scripts/bench-smoke.sh 100000 50` (fresh node, fsync on) | ✔ all six complete (numbers below) |
| kill -9 and restart loses no acknowledged write (fsync on) | `pnpm test:durability`: 50 iterations of start → INCR/SET/RPUSH bursts → SIGKILL at a random moment → restart → verify every acknowledged write | ✔ 50 kills; 4,880 acknowledged INCRs, SETs and RPUSHes each verified; 32 entries replayed during restarts |

### redis-benchmark (Apple M-series laptop, Node 26.10, `-n 100000 -c 50 -q`)

| Test | Requests/s | p50 |
|---|---|---|
| SET | 15,550 | 2.9 ms |
| GET | 38,081 | 1.2 ms |
| INCR | 15,309 | 2.9 ms |
| LPUSH | 13,142 | 3.3 ms |
| HSET | 11,071 | 4.2 ms |
| ZADD | 9,131 | 5.0 ms |
| SET `-P 16` | 15,265 | 48.8 ms |
| GET `-P 16` | 49,677 | 14.8 ms |

Every write is fsynced before it is acknowledged; group commit shares one fsync across the writes of all connections in an event-loop turn. Writes pipelined on one connection do not batch yet, because a connection runs its commands strictly in order and waits for each write's apply so that later reads see it. Raising that is phase 11 work. These are smoke numbers, not tuned benchmarks.

## Other checks run

| Check | Command | Result |
|---|---|---|
| Lint (ESLint + boundaries, madge, Prettier) | `pnpm lint` | ✔ |
| Typecheck (sources + tests) | `pnpm typecheck` | ✔ |
| Tests | `pnpm test` | ✔ 80 files, 644 tests: storage 35, statemachine 33, kv 149, services 17, adapter-resp 182, server 17, compat + integration 16, phase 0 packages and architecture the rest |
| Coverage | `pnpm test:coverage` | Statements 93.5%, branches 85.5%, functions 96.1%, lines 96.5% (thresholds 85/80/85/85) |
| RESP parser fuzzing | `FUZZ_RUNS=1000000 pnpm fuzz:resp`: random bytes, mutated valid pipelines and round-trips, each under random chunking | ✔ 3 × 1,000,000 runs, 63 s |
| Python | `uv run ruff check`, `ruff format --check`, `mypy --strict`, `pytest` | ✔ 31 tests (8 + 23 compat) |
| Protobuf | `buf lint`; regenerate + `git diff --exit-code`; `buf breaking` | ✔ |
| CI workflows | `actionlint` over `.github/workflows/*.yml` (new `gate` job) | ✔ |
| Dependencies | `pnpm audit`; `uvx pip-audit` | ✔ (only the previously accepted braces advisory) |
| Repository rules | all commits authored and committed by Vishvak; no `Co-Authored-By`; no CLAUDE/`.claude`/AGENTS/`docs/references` files tracked | ✔ |
| Manual | `pnpm dev`, then `redis-cli PING`, `SET`/`INCR`/`HSET`/`HGETALL -3`/`ZADD`/`ZRANGE WITHSCORES`, `COMMAND COUNT`, `COMMAND DOCS GET`, `INFO server`; `SIGTERM` stops gracefully | ✔ |

## Phase 1 checklist (PLAN 24)

| Task | Where |
|---|---|
| `@mindlog/storage`: `KvStore` port, LevelDB adapter, `WriteBatch`, snapshots, MVCC by version, tombstones, GC by threshold, in-memory fake | `packages/storage` (shared contract suite on both stores; fake-vs-LevelDB and MVCC model property tests) |
| `@mindlog/statemachine`: command envelope, deterministic apply, idempotency table, `appliedIndex`, local log behind the `Proposer` port | `packages/statemachine` (`LocalLog`, `LocalProposer` with group commit, `recover`, determinism tests) |
| `@mindlog/kv`: strings, hashes, lists, sets, sorted sets, JSON subset, TTL (lazy + replicated expiry job), SCAN, MULTI/EXEC/WATCH | `packages/kv` (100 commands, model-based property tests, Valkey-ported cases), `packages/services` (sessions, AUTH, transactions) |
| `@mindlog/adapter-resp`: incremental RESP2/RESP3 parser, serializer, pipelining, HELLO, AUTH, command table + COMMAND DOCS, output buffer limits | `packages/adapter-resp`, `commands/*.json`, `docs/api/resp-compatibility.md` |
| Graceful shutdown (stop accepting, drain, flush, close) | `packages/server` (`startNode().close()`, SIGINT/SIGTERM) |
| Fuzz the parser; ioredis and redis-py suites; redis-benchmark | `pnpm fuzz:resp`, `test/compat`, `python/compat`, `scripts/bench-smoke.sh`, CI `gate` job |
| Deliverable: `mindlog-server --single-node` works with `redis-cli` | `packages/server/src/bin.ts`, `pnpm dev` |

Decisions recorded: ADR-0005 (two LevelDB instances; truncation record added this phase), ADR-0021 (KV writes replicated as argv), ADR-0022 (collection generations for O(1) DEL), PLAN 5.1/5.2/6.1 updates.

## Defects found by the gate tests

| Found by | Defect | Fix |
|---|---|---|
| Parser fuzz target | A bare LF ended a multibulk header and skipped a data byte, so results depended on chunking; `Number()` accepted empty, spaced, hex and exponent counts | `5c4fab4`: headers end at CR and parse like Valkey `string2ll`; regression tests |
| Server restart test | A log compacted up to its last entry reopened with `lastIndex 0`, so recovery saw state ahead of the log and new appends would have reused indexes | `54ec959`: compaction records the truncated index in the same synced batch (ADR-0005) |

## Known gaps and follow-ups

- Pipelined writes on one connection are not batched (see benchmarks); phase 11.
- Unknown commands return Valkey's exact message, without the docs link that CLAUDE.md §9 mentions, so client test suites that match the text keep passing.
- Differences from Valkey are listed in `docs/api/resp-compatibility.md`.
