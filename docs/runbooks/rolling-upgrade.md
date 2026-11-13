# Rolling upgrade

**Before.**
- Read the release notes (`CHANGELOG.md`).
- Take a backup: `POST /api/admin/backups {"id":"pre-upgrade"}` on every node, then `backup verify pre-upgrade`.
- Make sure every range has a healthy majority (dashboard Cluster page).

**Steps**
1. Upgrade one node at a time. For each node:
   1. Move its leaders away (`transfer-leader`, or `drain-node` then `undrain-node` after the upgrade).
   2. Stop it, replace the binary or image, and start it with the same config and data directory.
   3. Wait until its applied indexes match the leaders' before moving on.
2. New command types stay disabled until every node runs the new binary. PD raises the cluster version when all nodes report the new binary version (PLAN 19.5). Mixed versions are safe in the meantime.
3. Upgrade the model service at any point; memory degrades, not fails, while it restarts.

**Verify.**
- `GET /api/cluster/overview` shows every node on the new binary version, and the cluster version raised.
- The phase demo or smoke tests pass.

**Rollback.**
- Before the cluster version rises: reinstall the old binary node by node.
- After it rises: restore the `pre-upgrade` backup ([restore-from-backup.md](restore-from-backup.md)).

**Record.** Versions before and after, and per-node durations.
