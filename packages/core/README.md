# @mindlog/core

Shared foundations for every Mindlog package (PLAN 4.2, layer `core`). It has no dependency on any other Mindlog package, and all other packages may depend on it.

## Purpose

- One way to report expected failures (`Result`, `MindlogError`, the error table).
- Deterministic building blocks for replication: injected time and randomness, ULIDs, the hybrid logical clock.
- The order-preserving key encoding that every stored key goes through.
- Configuration, logging, metrics and tracing behind narrow ports, so higher layers never import pino, prom-client or OpenTelemetry directly.

## Public API

| Area | Exports | Notes |
|---|---|---|
| Results | `Result`, `ok`, `err`, `isOk`, `isErr`, `map`, `mapErr`, `andThen`, `unwrapOr` | Expected failures only; programmer errors throw |
| Errors | `MindlogErrorCode`, `ERROR_CODES`, `errorSpec`, `mindlogError`, `toErrorDetail`, `isRetryable`, `problemType`, `GrpcStatus` | The single table mapping each code to RESP prefix, HTTP status, gRPC status, MCP error kind and retryability (CLAUDE.md §9) |
| Time | `Clock`, `SystemClock`, `ManualClock` | `now()` is epoch ms, `monotonic()` is ns; both `bigint` |
| Randomness | `Random`, `SystemRandom`, `SeededRandom` | `SeededRandom` (xoshiro128** seeded by SplitMix64) reproduces any `bigint` seed exactly |
| Ids | `UlidGenerator`, `isUlid`, `ulidTime` | Monotonic ULIDs from the Clock and Random ports |
| HLC | `HybridLogicalClock`, `Hlc`, `packHlc`, `hlcPhysical`, `hlcLogical` | 48-bit ms + 16-bit counter in one `bigint` (fits proto `uint64`) |
| Keys | `SYSTEM_TENANT`, `isUserTenant`, `encodeTuple`, `appendTuple`, `decodeTuple`, `encodeKey`, `decodeKey`, `keyPrefix`, `prefixRange`, `versionsRange`, `KeyFamily`, `ByteWriter`, `appendVersion`, `TupleCode` | See "Key encoding" below |
| Config | `resolveConfig`, `configSchema`, `MindlogConfig` | Pure: defaults → YAML → `MINDLOG_*` env → flags |
| Logging | `Logger`, `createLogger`, `MemoryLogger` | pino JSON lines, secrets redacted, bigints exact |
| Metrics | `Metrics`, `PromMetrics`, `MemoryMetrics`, `assertMetricName` | Names must be `mindlog_<area>_<thing>_<unit>` |
| Tracing | `Tracer`, `OtelTracer`, `initTracing` | Off unless an OTLP endpoint is configured |
| Scopes | `ScopePath` | tenant / user / agent / session (PLAN 5.5) |
| Checksums | `crc32c` | CRC-32C for log entries and segments (PLAN 7.3) |

Every port has a production implementation and an in-memory one (`ManualClock`, `SeededRandom`, `MemoryLogger`, `MemoryMetrics`). Both are exported because the simulator and other packages' tests use them. Shared contract suites live in `test/contracts/`.

## Key encoding

Keys use FoundationDB tuple-layer typecodes (PLAN 5.1). Each element is self-delimiting, so no separator bytes are needed:

```
key := element(tenant) element(family) element(e1) … element(en) [ 0x40 ~index(8 bytes) ]

null 0x00 · bytes 0x01 … 00 · string 0x02 utf8 … 00 · integer 0x0c–0x1c · double 0x21 · false 0x26 · true 0x27
```

- `0x00` inside bytes or strings is escaped as `0x00 0xff`.
- Integers are `bigint` in ±(2^64 − 1). The type code carries the sign and byte length; negatives store the one's complement.
- A `number` is always an IEEE double, ordered by IEEE total order with one canonical NaN.
- The version suffix is the bitwise-NOT of the commit index, so the newest version sorts first, and all versions of a key are contiguous.

## Invariants

- **Byte order equals tuple order.** Checked for 100k random tuples against an oracle written from the spec (`test/keys/key-order.test.ts`, the phase 0 gate).
- **Every key has exactly one encoding.** `decodeTuple` rejects non-canonical, truncated or unknown input with `KEY_DECODE_FAILED` and never throws.
- **Every key starts with a non-empty tenant** (CLAUDE.md rule 10). Tenant prefix ranges never overlap.
- **HLC timestamps strictly increase** and dominate every remote timestamp merged into them. Remotes further ahead than `maxOffsetMs` are rejected with `CLOCK_OFFSET_EXCEEDED`.
- **ULIDs strictly increase** even when the wall clock stalls or steps backwards.
- **No ambient time or randomness.** Code that needs time or randomness takes a `Clock` or `Random`, so the simulator can reproduce any run from a seed.
- **Config resolution is pure** and rejects unknown keys. Reading `mindlog.yaml` is the composition root's job.

## Differences from PLAN 4.3 sketches

- `Random` has no `seed()`. Only `SeededRandom` can be reseeded, so production code cannot accidentally reseed a cryptographic source. The port has `next()`, `nextUint32()` and `fillBytes()`.
- `Clock.now()` is epoch milliseconds and `monotonic()` is nanoseconds, both `bigint`, as sketched.

## Metrics emitted

None. `core` provides the registry; the packages that do the work emit the metrics.
