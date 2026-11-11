# ADR-0014: Encryption at rest

- Status: accepted
- Date: 2026-11-11
- PLAN: 10.6, 18.1 (tampering, disclosure), 18.4, 24 phase 10
- References: [ADR-0005](0005-separate-leveldb-for-raft-log.md), [ADR-0026](0026-raft-log-format-v2.md)

## Context

PLAN 10.6 asks for per-tenant data keys (AES-256-GCM) wrapped by a master key, with values encrypted and keys left in plaintext so ordering still works. Every byte reaches disk through the `KvStore` port, the blob store port, or the Raft log, which is also a `KvStore`.

## Decision

- **`EncryptingStore`** decorates `KvStore` in `@mindlog/storage`. It is wired where the node opens its LevelDB instances (state and Raft log, and the PD's two) and seals every value as `0xE1 · keyId · nonce · AES-256-GCM(value) · tag`, with the full storage key as associated data, so a value cannot be moved to another key.
- **Data keys are per node and per scope.** The scope is the key's tenant, `$system`, or `$node` for the node's own rows. Raft log rows are `$node` rows, so the log uses one node-level key: a log entry carries no tenant the store can see.
- **The keyring** lives in the same store under `$node·s·('crypto', …)`, each data key wrapped by the master key. A new key's row goes into every batch that uses it until one of them is written, so a value is never durable without its key. These rows and the marker are hidden from readers.
- **A marker row** records that a store is encrypted and checks the master key. Opening refuses: an encrypted store without a key, a key that does not open the marker, and a store that already holds plaintext. Encryption is for new data directories only.
- **Snapshots stream plaintext** between nodes (over mutual TLS) and are sealed again under the receiver's keys.
- **Blobs** (`EncryptingBlobStore`) use a per-tenant key derived with HKDF from the master key. A blob store can be shared by every node (S3), so its keys must be the same on each, which a per-node keyring cannot give. Every node of a cluster then needs the same master key.
- **The master key** is `storage.encryption.masterKey` (base64, 32 bytes), best supplied as a file (`MINDLOG_STORAGE__ENCRYPTION__MASTER_KEY_FILE`). `mindlog-server keys rotate-master --new-key-file` re-wraps a stopped node's keyrings.
- **Crypto-shredding**: `EncryptingStore.forget(tenant)` drops a tenant's data keys. Tenant deletion calls it only after the tenant's rows are gone, or GC would fail-stop on rows it cannot open.

## Alternatives considered

- **Encrypting command bodies before proposing**, so the log is per-tenant too: changes the replication format and needs tenant keys shared across nodes (the user chose against it).
- **Replicated data keys**: one key per tenant for the cluster, at the cost of distributing keys through Raft and a key-management protocol.
- **LevelDB-level or filesystem encryption**: one key for everything; no per-tenant shredding.

## Consequences

- **Key names are plaintext.** So are memory index terms, which are keys (`m/(user,'t',term,…)`), entity ids, collection names and record ids. Values, including memory text, embeddings and Raft entries, are sealed. Keyed hashing of terms is ruled out because data keys differ between nodes.
- About 5.5 µs per written value and 6 µs per read (LevelDB, 200-byte values, M-series laptop, `test/bench/encryption.test.ts`).
- Data-key rotation is not implemented; only the master key rotates.
- A lost master key loses the data.
- Blob keys are derived, so deleting a tenant's blobs is the only way to shred them.
