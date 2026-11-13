# Rotating the master key

Encryption at rest (ADR-0014) wraps per-tenant data keys under `storage.encryption.masterKey`. Rotation re-wraps the keys; the data is not re-encrypted.

**Steps (per node, one at a time)**
1. Create a new key: `openssl rand -base64 32 > new.key && chmod 600 new.key`.
2. Stop the node.
3. Run `mindlog-server keys rotate-master --new-key-file new.key [-c mindlog.yaml] [--data-dir <dir>]`. It re-wraps the node's own stores and its PD's, and reports `re-wrapped N data keys` for each.
4. Point `storage.encryption.masterKey` (or `MINDLOG_STORAGE__ENCRYPTION__MASTER_KEY_FILE`) at the new key, then start the node.

**Verify.**
- The node starts. A wrong key refuses to open the directory: `encrypted with another master key`.
- Data reads back.

**Caution.** Blobs (the cold tier, files and backups) use keys derived from the master key, and they are not re-wrapped. Keep the old key to read backups taken before the rotation.

**Record.** The rotation date, and where the old key is kept, and for how long.
