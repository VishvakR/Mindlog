# @mindlog/index-graph

Entity identity and graph walks for memory (PLAN 11.3). Personalized PageRank comes in phase 6.

## Public API

- `normalizeName(name)`: NFKC, lowercase, single spaces, no punctuation at the edges.
- `entityId(type, name)`: `type:normalized name`, so two writers naming the same entity converge (ADR-0031).
- `walk(reader, seeds, { depth, limit })`: an undirected breadth-first walk over a `GraphReader` port. Depth is capped at 2 and `limit` bounds the node count; it returns nodes with their depth, the edges seen, and whether it was `truncated`.

## Invariants

- The package knows no keys. The memory engine stores edges under `m/(user, 'g', 'out'|'in', src, relation, dst)` and supplies the reader.

Emits no metrics.
