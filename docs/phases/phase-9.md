# Phase 9 — Full-stack backend mode: exit-gate evidence

- Date: 2026-11-08
- PLAN: §24 Phase 9 (§16, §15 REST, §17 Collections, §18 delegated tokens)
- Status: **built, awaiting sign-off**
- Decisions: ADR-0018 (rule language), ADR-0034 (one key prefix per collection, bodies 50–51, cluster version 9), ADR-0035 (app auth).
- Scope choices by the user:
  - The full PLAN list, with OTP and OAuth2 kept but **opt-in and off by default**; email verification and reset follow the same mail switch.
  - `sharp` for thumbnails; our own HS256 JWT; argon2id from Node's `crypto.argon2`; our own SMTP and OIDC clients.
  - Simulator at 100–300 seeds.

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| Authorization matrix: every rule slot × role × ownership | `test/integration/collections-authz.test.ts`, over HTTP on a real node: 5 slots × 3 rule modes (locked, public, owner) × 6 roles (guest, user, superuser, delegated agent, API key, other tenant) × 3 ownerships = **270 cases** against an oracle of PocketBase's status conventions, plus `manageRule`, tenant isolation and hidden fields | pass |
| App works end to end | `scripts/phase9-demo.sh` (`DEMO_OTP=1` adds OTP with the console mailer): two users, CRUD, attachment and thumbnail, realtime only to the owner, the assistant agent through a delegated token, cross-user denials. All steps pass. The browser app (`examples/todo-app`) was driven in Chrome with two users and two tabs: live updates across tabs, thumbnails, session across reload, the other user sees nothing | pass |

## Other checks run

- **Full suites:** `pnpm typecheck` and `pnpm test:coverage` pass: 1,606 tests, 2 skipped; statements 90.6%, branches 80.8%, functions 92.5%, lines 94.1%. `pnpm format:check`, cycles, web lint and commitlint over this branch pass. ESLint passes on the repo; its only complaints are three stale gitignored debug files under `.claude/tmp/`.
- **One failure seen and not fixed:** `embedded-pd.test.ts` ("keeps serving MGET, DBSIZE and writes across ranges after a split") failed once in a full run and passed in three solo runs and the coverage run. It is the known phase 4 flake.
- **Python:** ruff, `mypy --strict` and pytest over `model_service` and `mindlog_proto` pass (35 tests). The proto body-number test had been stale since phase 8 and is fixed.
- **Protobuf:** `pnpm proto:lint` and `pnpm proto:breaking` pass; new bodies 50 and 51, `Command.actor = 6`, result field 6.
- **Simulator:** `SIM_COLL=1 scripts/sim.sh 300 4` passes 300 seeds (concurrent creates, updates and deletes on a unique index through splits, merges, partitions and crashes; unique values stay unique and index rows match records). `SIM_MEM=1 scripts/sim.sh 100 4` passes 100 seeds.
- **Dashboard:** driven in Chrome against a real node: filters, file previews, the rule editor's completion and live errors, a password reset. [Screenshot](phase-9-collections.png).
- `pnpm audit`: 25 advisories, the same count as before this phase.

## Bugs found by the gates

- The first 300-seed sim reported an acknowledged record missing. A replay showed the workload's bookkeeping was wrong, not the data: an update's answer arrived after a later delete's and marked the record alive. Fixed in the workload.
- The dashboard's CSP blocked its own blob-URL image previews; found in the browser run.
- The owner rule `user = @request.auth.id` matches guests on records with an empty owner, because `''` equals a guest's empty id. This is PocketBase's behaviour too. The tests and the example use `@request.auth.id != '' && …`, as PocketBase advises.

## Not done, or done differently

- **Views are not truly incremental.** PLAN 16.7 asks for incremental maintenance. A refresh re-reads every source record (up to 10,000) and writes only the rows that differ, because an update's command does not carry the old group key. Refreshes are durable jobs enqueued in the source write, so no change is missed on a leader change, which removes the rebuild-on-leader-start the plan expected.
- **No `index-secondary` package, no 2PC for unique indexes** (ADR-0034): a collection stays in one range, so unique checks are single-range. The cost is that one collection cannot be split by size, and its writes go through one Raft group.
- **File names are random per upload**, not the content hash of PLAN 16.5, so a refused write can delete its own blobs without touching a file another record shares.
- `FileMeta` (body 52) was not needed: file names are record fields. `RecordChanged` is still never published; realtime uses the change feed.
- Before hooks, password hashing and embedding run on the node that took the request, before proposing, not strictly on the leader. Followers never repeat them.
- After hooks run at least once (job leases), not exactly once.
- Hooks are limited in time and memory, not sandboxed: they are the operator's code (ADR-0035). One worker runs one call at a time.
- OTP and OAuth2 were tested against an in-process fake SMTP server and a fake OIDC provider, never real Google or GitHub.
- S3 list and file paths were tested against the signature-checking fake only, not real MinIO (the phase 8 gap remains).
- Collections over 10,000 records refuse schema rewrites and hit the same limit on unindexed lists, view refreshes and the file janitor (`MAX_SCAN`, `MAX_REWRITE_RECORDS`).
- Realtime reaches clients only for ranges the serving node holds a replica of, and resume reads the in-memory tail of one range. No per-subscription filter option.
- `collection_via_field` back-relations in rules are not implemented. `fields=` picks top-level keys only.
- Upload bytes are buffered in memory (`BlobStore` has no streaming). MIME type limits trust the client's declared type; downloads of anything but a short list of inert types are attachments.
- The dashboard's record form does not upload files; apps and the API do.
- A delegated token stays valid for its 15 minutes after its API key is revoked.
- API keys are still tenant- and user-scoped only; PLAN 16.4's per-permission scopes and expiry are left for phase 10's RBAC. Record ids are always the 15-character form; the ULID option is not configurable.
- Nobody independently reviewed this branch.
