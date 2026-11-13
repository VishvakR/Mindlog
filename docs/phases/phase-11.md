# Phase 11 — Performance, chaos, benchmarks, documentation, launch: exit-gate evidence

- Date: 2026-11-13
- PLAN: §24 Phase 11 (§1.5, §10.5, §19.4, §20.3–20.4, §21)
- Status: **built, awaiting sign-off**
- Decisions: ADR-0041 (full backups from range snapshots).
- Scope choices by the user:
  - "Don't test everything, just implement what is necessary; benchmark is not required."
  - Full backups only, with no incremental segments or point-in-time restore.
  - MIT license.
  - Plain Markdown docs instead of a docs site.

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| All SLO targets measured and published (met or explained) | [`docs/slo.md`](../slo.md): every §1.5 row with its number and source from the phase 1–10 gates. Rows without a percentile run (KV p99 on 3 nodes, memory-write p95, recall at 100K) are marked not measured, with the reason | **explained**: met where measured; no new benchmark run |
| Zero acknowledged-write loss across chaos runs | Earlier gates: `pnpm test:durability` (kill -9 under load), 30 failover kills (phase 3), Maelstrom `lin-kv` with partitions (nightly), simulator seeds. No new chaos week was run | met on the existing runs |
| Docs and demo public | Docs: [`docs/README.md`](../README.md), getting started, [MCP tools](../api/mcp-tools.md), [OpenAPI](../api/openapi.json), runbooks, ADR index, [write-up](../blog/design-writeup.md). Demo: [video script](../demo/video-script.md). The video is not recorded, and nothing is pushed or published by this phase | **partial**: docs written; video and publishing left to the user |

## What was built

| Task (PLAN 24) | Where | Notes |
|---|---|---|
| Backup/restore verification job; runbooks complete | `packages/server/src/bootstrap/{backups,backup-format,restore-backup}.ts`, `cli/backup.ts`, `POST /api/admin/backups`, `backup.*` config; `docs/runbooks/*.md` (11) | Each node backs up the ranges it leads (range 0 included) to `backups/<id>/`. `backup verify` restores into memory; `backup restore` writes a new one-node data directory (`soleVoter`, `clearPlacement`); `backup.verify` checks the previous backup on PD's leader |
| Chaos: disk full | `mindlog_raft_replica_failures_total` in `Replica.#fail`; runbook `disk-full.md` | Fail-stop already existed; PD does not move a single failed replica (ADR-0041) |
| Docs site | Markdown under `docs/` | The MCP reference is checked against the registered tools by `packages/adapter-mcp/test/mcp-server.test.ts` |
| v1.0.0 release | `LICENSE` (MIT), `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `THIRD_PARTY_NOTICES.md`, `.github/workflows/release.yml`, versions 1.0.0 | A pushed `v1.0.0` tag builds and pushes the GHCR images and attaches the SDK packages and SBOMs; it has not run yet |
| Blog post, demo video | `docs/blog/design-writeup.md`, `docs/demo/video-script.md` | Script only |

## Checks run

- `packages/server/test/backup.test.ts`, 4 tests:
  - `soleVoter` rewrite;
  - coverage refusal (gap, missing PD, no end);
  - start a node → 20 SETs → `backupNow` → `backup verify` (with config, and with `--from`) → `backup restore` into a new directory (a second restore is refused) → start the restored node → all 20 GETs and a new SET succeed;
  - usage errors.
- Manual, on the built binary:
  - `superuser upsert` → node on :6391 → `SET hello world` → `POST /api/admin/backups {"id":"manual1"}` answered `{"ranges":["1","0"]}`;
  - stop → `backup verify manual1 --from …` → `backup restore … --data-dir b` → node on b → `GET hello` returned `world`.
- Test suites of the touched packages (core, adapter-http, multiraft, pd, statemachine: 383 tests), plus the MCP and RESP doc tests.
- `pnpm lint` (ESLint without the gitignored `.claude/tmp` scratch files, cycles, Prettier, web), `pnpm typecheck`, `pnpm lint:commits`.
- Local runs of the release steps: `pnpm --filter @mindlog/sdk pack` and `uv build --package mindlog`.
- Full `pnpm test` (1,779 tests): two `test/integration/tls.test.ts` failures and one unhandled rejection.
  - **TLS:** the failures come from the shell. `/usr/bin/openssl` (LibreSSL 3.3.6) came first in PATH, and its test CA uses a digest Node rejects (`ca md too weak`). With Homebrew's OpenSSL first, all 9 pass.
  - **Unhandled rejection:** `Database is not open` from `Replica.open` → `rememberReplicaId`, in `packages/server/test/embedded-pd.test.ts`. A replica made by a split was opening while the node closed. The file passes 3 of 3 runs on its own. The race is pre-existing (not in code this phase touched) and is left open.

## Gaps and deviations

- **No benchmarks or profiling:**
  - no memtier, recall load generator or flame graphs;
  - no hot-path optimisation (CLAUDE.md: measure before optimising);
  - no 1- vs 3-node runs, and no failover under load.
- **No chaos week:**
  - no new partition, disk-full, clock-skew or model-outage scripts;
  - the zero-loss claim rests on the earlier durability, failover, Maelstrom and simulator runs.
- **Backups (ADR-0041):**
  - no cluster-wide TSO cut, no incremental log, no point-in-time restore;
  - a split or merge during a backup makes it unrestorable, so take the next one;
  - with a local blob store, a cluster's backup is spread over the nodes' disks;
  - cold-tier and file blobs are referenced, not copied.
  - The restore was exercised on single-node backups only, not on a multi-node cluster's.
- **Docs:**
  - the OpenAPI JSON is a snapshot; rerun `scripts/openapi.sh` after API changes;
  - the docs are plain Markdown.
- **Release:**
  - the workflow is untested until a tag is pushed;
  - packages stay private, with no npm or PyPI publish;
  - the demo video is not recorded.
