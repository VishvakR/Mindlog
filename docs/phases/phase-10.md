# Phase 10 — Security hardening, multi-tenancy, scale features, SDKs: exit-gate evidence

- Date: 2026-11-13
- PLAN: §24 Phase 10 (§8.5, §10.6, §13.10, §15.5, §18)
- Status: **built, awaiting sign-off**
- Decisions: ADR-0014 (encryption at rest), ADR-0036 (tenants and RBAC), ADR-0037 (audit log), ADR-0038 (quotas and rate limits), ADR-0039 (semantic split), ADR-0040 (embedded replica sync). New command bodies 100–104, cluster version 10.
- Scope choices by the user:
  - Semantic split built for real, not only measured on paper.
  - Embedded replicas in both TypeScript and Python.
  - Dashboard accounts for tenant roles as well as API keys.
  - Encryption per tenant for state and blobs, a node key for the Raft log.
  - Simulator and evals at 100–300 seeds or items.

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| Cross-tenant access fuzzing finds nothing | `test/integration/tenant-fuzz.test.ts`: two tenants hold canaries in KV, memory and the audit log; 300 seeded fast-check runs (seed 1009) of a random caller (4 roles × 2 tenants) sending random operations over HTTP (10 memory ops, KV, 7 tenant admin paths), RESP (`GET`, `KEYS`, `MEM.SEARCH`, `MEM.GET`) and MCP (`recall`, `history`), aimed at its own tenant or the other. No answer carried the other tenant's canary, and every request naming the other tenant failed. A negative control proves the check can fail: a superuser, who may read every tenant, does see the canary | pass |
| Semantic-split recall@10 within 5% of the single-range baseline, or a documented gap | `scripts/split-eval.sh 100 100`: LongMemEval 100-question subset, each question's haystack in one scope, once on one range (`maxMemories 0`) and once forced to split at 100 memories. All 100 scopes split, into 387 clusters (up to 5 per scope). Turn recall@10, single range → split (top-2 clusters): vector 92 → 85 (−7.6%), hybrid 94 → 88 (−6.4%), hybrid + PPR 93 → 89 (−4.3%). Details and the gap below | **documented gap**: hybrid + PPR is inside 5%, hybrid and vector are not |

### Semantic split: measurement and gap

| Run | Degraded writes | Vector R@10 | Hybrid R@10 | Hybrid + PPR R@10 | Session R@10 (V / H / H+PPR) | p50 ms (V / H / H+PPR) |
|---|---:|---:|---:|---:|---|---|
| One range ([single](../evals/phase-10-single.md)) | 1,747 | 92 | 94 | 93 | 99 / 98 / 99 | 13 / 34 / 43 |
| Split, top-2 clusters, the default ([split](../evals/phase-10-split.md)) | 2,652 | 85 | 88 | 89 | 94 / 92 / 92 | 27 / 56 / 65 |
| Split, top-3 clusters ([split-top3](../evals/phase-10-split-top3.md), `memory.split.recallClusters=3`) | 5,250 | 83 | 89 | 88 | 97 / 96 / 96 | 29 / 67 / 80 |

- **Bytes moved:** 24,686 moves and 56.2 MB for 25,456 memories. Splits recurse: a scope of about 255 memories splits at 100, then each half splits again, and each split moves about half of its cluster, so the moves add up to about one per memory. The source keeps each moved record (unindexed, for history), so records are stored twice until a cleanup that is not built.
- **What the gap is not:** routing breadth. Searching 3 clusters instead of 2 raises session-level recall (96–97 against 92–94) but not turn-level recall@10. The likely causes are the fusion and the per-cluster statistics: clusters are fused by rank (RRF), so each cluster's rank-1 item counts the same and a far cluster's best guesses push true hits out of the top 10; BM25 statistics, entities and graph walks are per cluster. Candidate fixes, not tried to avoid tuning on the eval set: weight each cluster's list by its centroid distance, or merge on comparable scores.
- **What it costs in latency:** p50 about doubles (a routing call, then two recalls in parallel); p95 stays under PLAN 1's 150 ms target (at most 104 ms with the default top-2 and 137 ms with top-3, though these scopes are far smaller than its 100K).
- **Caveats:** the clusters here hold about 64 memories, far below a real split at the default 100,000, which makes routing noisier than in production. Degraded writes (stored raw while the model service was saturated, enriched before scoring) vary between runs with machine load. An earlier single-range run on a loaded laptop had 11,600 and vector recall@10 of 73; it was rerun on a quiet machine for the table above.

## Deliverables

- **Two tenants on one cluster with quotas.** `scripts/phase10-demo.sh` starts a node, creates `acme` (5 writes/s) and `globex` (no quota) and writes 30 keys as fast as curl goes as each: acme had 6 to 10 accepted (depending on curl's speed) and the rest rate-limited, and globex had all 30 accepted. `test/integration/access-control.test.ts` also covers a connection quota, `packages/services/test/governor.test.ts` the storage, key, memory and model-second quotas, and `packages/pd/test/tenant-budgets.test.ts` how PD splits a tenant's rate across nodes.
- **An agent with an embedded replica keeps reading while the network is cut.** One JSON scenario (`test/scenarios/replica-offline.json`) runs against a real node through a TCP proxy whose link is cut, in both SDKs (`test/integration/sdk-replica.test.ts`, `python/sdk/tests/test_scenario.py`): snapshot, follow, cut, local reads and keyword recall keep working, writes queue, a write made on the server meanwhile arrives after the link is back, the queued writes replay once (client request ids) and read-your-writes holds. Both pass.

## Other checks run

- **Full suites:** `pnpm typecheck` and `pnpm test:coverage` pass: 1,772 tests, 3 skipped; statements 90.2%, branches 80.3%, functions 92.5%, lines 93.8%. Branch coverage had fallen to 78.9% with this phase's code; tests for the split fan-out, the audit service, the usage sampler, key rotation and the tenant admin routes brought it back over the 80% threshold. `pnpm lint:cycles`, `pnpm format:check`, web lint, `pnpm proto:lint` and `pnpm proto:breaking` pass. ESLint passes on the repo; its only complaints are three stale gitignored debug files under `.claude/tmp/`. The known `embedded-pd` flake did not show in these runs.
- **Python:** ruff, `mypy --strict` and pytest over `model_service`, `mindlog_proto` and `sdk` pass: 80 tests in the default run (the SDK's tests among them, against a built node), plus `uv run mypy -p mindlog.sdk` and `mypy evals/src`.
- **Simulator** (300 seeds, 4 workers each, run when each workload landed; later changes leave the simulated paths alone):
  - `SIM_ENC=1`: every replica's state read through `EncryptingStore`, with splits, merges, partitions and crashes; replicas hash equal through the decorator, since random nonces make raw bytes differ.
  - `SIM_TENANT=1`: a tenant purged during splits and crashes leaves no key of that tenant, and the other tenant's acknowledged writes are all there.
  - `SIM_SPLIT=1`: memories are written, forgotten and re-homed through splits and crashes; nothing acknowledged is lost, nothing forgotten comes back, and no id is visible twice. Seed 74 failed first (below) and is now a regression seed.
- **Authorization matrix:** `test/integration/access-control.test.ts` (role × action × ownership × tenant over HTTP, RESP and MCP, policy rows, scope patterns, expiry and revocation, dashboard accounts) and `packages/auth/test/policy.test.ts` (unit and property tests of `decide`).
- **TLS:** `test/integration/tls.test.ts`: the production profile refuses to start without TLS; RESP over TLS refuses plaintext; HTTPS; a rotated certificate is served without a restart and a broken one is ignored; two nodes exchange Raft messages over mutual TLS, also after a rotation; a peer with a certificate from another CA cannot connect; settings never show a secret, S3 keys included. The model sidecar's mutual TLS has its own Python test.
- **Encryption:** contract suites run on `EncryptingStore` and `EncryptingBlobStore`; a test greps the raw LevelDB files for a planted value and finds none; master-key rotation and per-tenant shredding (`encrypting-store.test.ts`); an encrypted data directory refuses to open without its key or with another one. Overhead measured at about 5.5 µs per write and 6 µs per read per value (noisy, on a laptop).
- **Tenant lifecycle:** `test/integration/tenant-lifecycle.test.ts`: redaction on and off (text, tags and metadata), export by an admin only, deletion refused at once and purged after the grace period with the other tenant untouched. Crypto-shred of one tenant's key is in `packages/storage/test/encrypting-store.test.ts`.
- **Audit:** `test/integration/audit.test.ts`: admin changes (failed ones with their HTTP status), refusals with the reason, a forget command audited through the outbox across a range split, and only the tenant's admin can read its log.
- **Dashboard:** the Tenants and Logs & audit pages, driven in Chrome as a superuser and as a tenant admin. The tenant admin sees only its tenant's pages, and no request it sends is refused.
- **Supply chain:** CI job `supply-chain`: `pnpm audit --audit-level high`, `pip-audit` over the hashed `uv export`, and `scripts/sbom.sh` (CycloneDX 1.5; 927 Node components, 89 Python). `pnpm audit` went from 25 advisories at the start of the phase to none, apart from two recorded as ignored in `pnpm-workspace.yaml` (zod 3 and deepmerge inside the shadcn CLI, which web uses only for its CSS and which has no patched release). The fixes are patched fastify and `@fastify/static` and overrides for transitive packages; minimatch moves a major version (11) for dev tools, with lint and tests passing. `pip-audit` finds nothing after setuptools 84.2.1.

## Bugs found by the gates

- `SIM_SPLIT` seed 74: a memory forgotten while it was being moved came back in its new cluster. The forget reached the source after the copy was made. A forget of an id not in a split scope's cluster now leaves a tombstone, the copy skips tombstoned ids, and the mover forgets copies whose source was not marked.
- `SIM_TENANT` hung: the final checks awaited simulated sleeps after the simulated world had stopped. The checks now drive the world while they wait.
- A list over a split scope showed a memory twice while it was being moved. Lists now drop duplicates within a page.
- The embedded replica's snapshot asked for 500 memories a page, over the schema's 200; it timed out instead of failing loudly. It asks for 200 and retries the snapshot while connected.
- The Python client sent `content-type: application/json` on GET requests, which Fastify refuses.
- The dashboard's home page asked a tenant admin's browser for the node-wide overview (403); members now start on Memory. Failed admin changes were audited as a bare "refused"; they now carry their HTTP status.
- The first split eval died on one write that missed its commit deadline (`TIMEOUT … may still be applied`) while the laptop also ran a typecheck next to the model service. The harness now retries `TIMEOUT` and `BUSY` writes (`MEM.ADD` takes no request id, so such a retry can store a turn twice; noted in the code). `split-eval.sh` never stopped its node and then waited on it forever; it now stops the node and the model service.
- `madge` found an import cycle in `services` (type-only, but this repo counts type imports): the tenant governor imported the tenant service for a type. `TenantRecord` moved to the tenant schemas.
- The coverage run reported 40 unhandled rejections: the audit timer was never stopped, so after a node closed (in tests, many nodes share a process) its next tick read a closed LevelDB. The audit and tenant-purge timers now run through one ticker that skips overlapping ticks, logs a failed one, and is stopped and awaited before the stores close.
- The recall fan-out of a split scope was a constant; it is now `memory.split.recallClusters` (default 2, at most 8), so the top-3 run above could be measured.

## Not done, or done differently

- **Semantic split differs from PLAN 8.5** (ADR-0039): clusters are sub-scopes (`user\u0000c<n>`), not a `cluster` component inserted into keys; k-means runs as a scope job in the worker pool, not in PD, because PD has no access to embeddings; centroids live in the root scope's `ScopeLifecycle`, not in the range descriptor. Conflict detection and graph walks are per cluster. `MEM.BRANCH` and the semantic cache are refused on a split scope. Moved records stay in the source, hidden by a marker, so the source's bytes do not shrink until a later cleanup, which is not built. Forget tombstones in split scopes are never collected. A list drops duplicates per page only.
- **Cluster calls between nodes** carry the cluster in the op name (`remember#2`), not in a new field, so the forwarding wire format is unchanged.
- **Encryption** (ADR-0014): data keys are per node and not replicated; snapshots travel decrypted over mutual TLS and are re-encrypted on arrival. Raft entries and range-local rows use a node key. Key names and index terms stay plaintext, so memory text is not fully hidden. No DEK rotation. Only new data directories can be encrypted.
- **Quotas are approximate:** storage, keys and memories are sampled every 30 s from approximate sizes, so a tenant can overshoot by what it writes in that window. Rate limits are per node with PD redistribution, not a global counter.
- **Tenant export** runs in the process that was asked, not as a durable job: a crash leaves it `running`, and the request has to be repeated. Memory scopes are found from the node's own listing.
- **Tenant names** of deleted tenants are never reused. The deletion request is audited in `$system`, because the purge removes the tenant's own audit log.
- **Audit rows** appear after the outbox is drained, not at commit; denials, logins and admin changes go through a bounded in-memory queue, so a crash can lose the last few (dropped entries are counted).
- **Embedded replicas** use `node:sqlite` in TypeScript (the plan said LevelDB) so both SDKs share one schema. Read-your-writes holds by the write's answer, stored locally, not by waiting for a log cursor. The change stream resumes from the server's in-memory tail; an older cursor gets a full re-read.
- **The Python SDK** uses only the standard library (`urllib`, `sqlite3`), not httpx. The LangGraph store and checkpointer were tested against LangGraph 0.4+; the CrewAI storage has CrewAI's method shapes but was not run inside CrewAI.
- **SBOM** for Node comes from cdxgen 12.9.0 through `pnpm dlx`, because pnpm 10 has no `sbom` command and `npm sbom` fails on `workspace:` links. Container image scanning is not built.
- Not in scope (as planned): pinning a tenant to dedicated nodes (PLAN 18.3, optional), anomaly alerts on API key use.
- Nobody independently reviewed this branch.
