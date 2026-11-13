# Placement driver quorum loss

**Symptom.**
- `/api/cluster/overview` fails, and the dashboard Cluster page is empty.
- Nodes log PD RPC failures.
- Splits, moves and rebalancing stop.
- Cross-range transactions fail, because they need TSO.

**Confirm.** Fewer than a majority of `pd.peers` are up. Plain KV and memory traffic keeps working on the cached range map (PLAN 21).

**Fix**
1. Restart the PD members that are down, with their own data directories (`pd.dataDir`, default `<dataDir>/pd`).
2. If a member's data is lost, restore the PD group from a backup:
   - A backup holds range 0 on PD's leader.
   - `mindlog-server backup restore` brings up a one-node cluster with PD embedded.
   - See [restore-from-backup.md](restore-from-backup.md).
3. Do not start a new PD group alongside the old one; ids and TSO must never go backwards.

**Verify.**
- `mindlog_pd_ranges_count` is back.
- Schedulers run again (`mindlog_pd_operators_count` changes).
- A cross-range transaction succeeds, if enabled.

**Record.** Which members failed, and how long schedulers were paused.
