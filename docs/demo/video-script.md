# Demo video script (5 minutes)

PLAN §24 phase 11: Redis compatibility → failover → agent memory over MCP → conflict, branch and time travel → dashboard. Record it at 1080p, with a terminal on the left and the dashboard on the right.

**Setup (before recording)**
- `pnpm build`.
- `docker compose --profile cluster up -d` for the 3 nodes, and the model service on :50051.
- Create a superuser and an API key (`apikey create --tenant demo --user ana --name video`).
- Open the dashboard at `/_/`, logged in, on the Cluster page.

| Time | Scene | On screen | Say |
|---|---|---|---|
| 0:00–0:30 | Intro | Cluster page: 3 nodes, ranges, leaders | "Mindlog is a Redis-compatible database replicated with Raft, which is also long-term memory for agents over MCP." |
| 0:30–1:15 | Redis compatibility | `redis-cli SET`, `HSET`, `ZADD`, `EXPIRE`, `MULTI/EXEC`; then `redis-benchmark -t set,get -n 20000` | "Standard clients and tools work unchanged." |
| 1:15–2:00 | Failover | `scripts/chaos/leader.sh`; a loop of `redis-cli INCR counter`; `scripts/chaos/kill-leader.sh` | "The leader dies; a new one serves writes in under two seconds, and no acknowledged write is lost." Point at the counter continuing and at the new leader on the Cluster page. |
| 2:00–3:00 | Memory over MCP | An MCP host (Claude Desktop, see `claude-desktop.md`): "I prefer dark roast, no sugar", then a new session: "What coffee do I like?" | "`remember` extracts facts and entities; `recall` returns a packed context with scores." Show the Memory and Recall pages with per-signal scores. |
| 3:00–3:40 | Conflict | Tell the agent "Actually I switched to green tea". Open the Conflicts page | "Contradictions are detected at commit time; the new fact waits in quarantine until someone resolves it." Resolve with `keep=both` and a `valid_from`. |
| 3:40–4:20 | Branch and time travel | `branch_create trip-plan`; remember on the branch; Branches page diff; `branch_merge`. Time travel page: recall `ASOF` before the switch | "Agents try plans on a branch without disturbing others, and can recall what was known at any earlier time." |
| 4:20–4:50 | Operations | Tenants page (quotas), Logs & audit, Jobs; `POST /api/admin/backups` | "Tenants, quotas, an audit log, and backups you can verify." |
| 4:50–5:00 | Close | README and docs index | "Everything runs offline. Docs, ADRs and measured results are in the repo." |

**After recording.** Run `docker compose --profile cluster down`.
