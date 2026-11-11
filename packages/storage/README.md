# @mindlog/storage

Ordered key-value storage behind the `KvStore` port, with MVCC on top (PLAN 10, layer `storage`). Domain and replication code depend on the port; only the composition root picks an adapter.

## Public API

| Area | Exports | Notes |
|---|---|---|
| Port | `KvStore`, `KvReader`, `WriteBatch`, `StoreSnapshot`, `Entry`, `IterateOptions` | Unsigned byte order; atomic batches with optional fsync; snapshots must be released |
| Adapters | `LevelDbStore.open(path, options)` → `Result`; `MemoryStore` | LevelDB via classic-level (ADR-0005); the in-memory store is the fake for every other package's tests |
| Encryption | `EncryptingStore.open(store, masterKey, name)`, `rewrapKeyring`, `seal`/`unseal` | AES-256-GCM per value under a per-node, per-tenant data key; keys stay plaintext; refuses plaintext or foreign-key directories (ADR-0014) |
| MVCC | `MvccWriter`, `MvccReader`, `MvccTxn`, `collectVersions` | Versioned writes at one version (the command's HLC timestamp in the state machine, ADR-0027), reads at a version, prefix scans, read-your-writes transactions for apply, bounded GC |
| Keys | `versionedKey`, `parseVersionedKey`, `keyAfter`, `compareBytes`, `decodeVersionValue` | `logical · 0x40 · ~version` (PLAN 5.1) |

```ts
const batch = store.batch();
const writer = new MvccWriter(batch, index);    // every write of one apply shares the index
writer.put(key, value);
writer.delete(other);                           // a tombstone, not a physical delete
await batch.write();

const reader = new MvccReader(store);
await reader.get(key);                          // latest visible value
await reader.get(key, 41n);                     // as of commit index 41
for await (const e of reader.scan(prefix, { after: cursor, limit: 100 })) …
```

## Invariants

- **Byte order is the only order.** Keys come from `@mindlog/core`'s tuple encoding, so byte order equals tuple order.
- **Fake and real store agree.** Both pass the same contract suite, and a property test checks that they return identical results on random workloads.
- **Writes are atomic per batch**, and a command's MVCC versions all share one index, so a command becomes visible all at once.
- **Deletes are tombstones**; history stays readable at older indexes until GC.
- **GC never changes reads at or above its threshold** (property-tested). It is deterministic, so replicas can run it inside apply.
- **Scans are prefix-based.** Versions sort after a key's extensions (`0x40` is above every element code), so a scan yields one entry per key only if no key under the prefix extends another. Collection element rows satisfy this; top-level key scans skip extensions with `keyAfter`.
- **I/O errors throw**, and the caller fails the replica rather than skipping work (CLAUDE.md rule 6). Opening a store returns `Result` (`UNAVAILABLE` when the directory is locked).
- **Callers own returned buffers**: values are copied into plain `Uint8Array`s.

## Metrics emitted

None yet. Store-level metrics (size, compaction and write stalls, PLAN 19.1) arrive with the server's maintenance loop.
