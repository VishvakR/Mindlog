# Restore from backup

Backups are full range snapshots in the blob store under `backups/<id>/` (ADR-0041).

**When.** Data loss on a majority of a range's replicas, a corrupted data directory, or a cluster rebuilt elsewhere.

**Before you start**
- Pick a backup id. List `blobs/backups/` (local store) or the bucket prefix `backups/`. Ids are times (`20261113T120000Z`).
- Check it: `mindlog-server backup verify <id> [-c mindlog.yaml] [--from <old-data-dir>]`. It restores into memory and checks sizes, checksums and keyspace coverage. A backup taken during a split or merge is refused; pick the next one.
- Use the same `storage.encryption.masterKey` the backup was written with.
- With a local blob store, every node wrote its own ranges to its own disk. Copy all nodes' `blobs/backups/<id>/` into one folder first. Use S3 to avoid this.

**Restore**
1. Stop any node that would use the target directory.
2. Run `mindlog-server backup restore <id> --data-dir <new-empty-dir> [-c mindlog.yaml] [--from <old-data-dir>]`. It refuses a non-empty directory.
3. Start the node: `mindlog-server --single-node --data-dir <new-empty-dir>`. Every range has this node as its only voter, and PD's range directory refills from heartbeats.
4. To grow back to a cluster, join new nodes (`cluster.join: true`). PD re-replicates.

**Verify.**
- `redis-cli DBSIZE`, and spot-check keys and memories you know.
- The dashboard Cluster page lists every range.
- New writes succeed.

**Limits.**
- Each range is restored at its own backup point. There is no point-in-time restore, and no cut consistent across ranges.
- Cold-tier segments and record files deleted after the backup are gone.

**Record.** The backup id used, its age (the data lost since then), and how long the restore took.
