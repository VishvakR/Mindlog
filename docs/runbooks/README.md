# Runbooks

Operating procedures (PLAN 19.4). Each runbook gives the symptom (an alert, metric or log line), how to confirm it, the fix step by step, how to verify recovery, and what to record afterwards.

| Runbook | When |
|---|---|
| [Node crash and replacement](node-crash.md) | A node is down or its disk is lost |
| [Disk full](disk-full.md) | Replicas fail-stop on storage errors |
| [Leader flapping](leader-flapping.md) | Elections keep happening |
| [Slow follower](slow-follower.md) | A replica lags its leader |
| [Model service down](model-service-down.md) | Memory responses are `degraded` |
| [PD quorum loss](pd-quorum-loss.md) | The placement driver has no majority |
| [Restore from backup](restore-from-backup.md) | Data must come back from a backup |
| [Rolling upgrade](rolling-upgrade.md) | Installing a new version |
| [Rotating certificates](rotate-certificates.md) | TLS certificates or the CA expire |
| [Rotating the master key](rotate-master-key.md) | Encryption-at-rest key rotation |
| [Tenant data export and deletion](tenant-export-delete.md) | A tenant asks for its data or its deletion |

Commands used throughout:
- `redis-cli CLUSTER.INFO`;
- the dashboard Cluster page, or `GET /api/cluster/overview`;
- node actions with `POST /api/cluster/actions` (`drain-node`, `undrain-node`, `remove-node`, `transfer-leader`, `split`);
- Prometheus metrics at `/metrics`, with the names listed in each package README.
