# @mindlog/blob

Blob storage behind one port (PLAN 10.4 cold tier, 16.5 files; ADR-0033).

## Public API

- **`BlobStore`**: `put(key, bytes)`, `get(key)` (undefined when missing) and `delete(key)` (missing is fine), each returning `Promise<Result<…, MindlogError>>`. A `put` is durable when it resolves.
- **`LocalBlobStore(root)`**: files under a directory; a put writes a temporary file, fsyncs it and renames it into place.
- **`S3BlobStore(options)`**: an S3-compatible bucket (MinIO) over `fetch`, path-style URLs, with our own AWS Signature V4 (`signRequest`, `signingKey`): no AWS SDK. Network errors and 5xx answers are `UNAVAILABLE`.
- **`MemoryBlobStore`**: in memory, for tests and the simulator.
- **`checkKey(key)`**: keys are `/`-separated segments of `[A-Za-z0-9._-]`, without `.`, `..` or empty segments, at most 512 characters.

## Invariants

- All three pass one contract suite (`test/blob-contract.ts`); the S3 run is opt-in with `BLOB_S3=http://host:9000`.
- Config `blob.default` picks the store (`local` with a path under `node.dataDir`, or `s3`); `secretAccessKey` is redacted from logs.

## Metrics

None. Callers count what they store (`mindlog_memory_tier_moves_total`).
