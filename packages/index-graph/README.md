# @mindlog/index-graph

Entity identity, graph walks, Personalized PageRank and communities for memory (PLAN 11.3, ADR-0011). Pure code: no keys, no I/O beyond the reader port.

## Public API

- `normalizeName(name)`: NFKC, lowercase, single spaces, no punctuation at the edges.
- `entityId(type, name)`: `type:normalized name`, so two writers naming the same entity converge (ADR-0031).
- `walk(reader, seeds, { depth, limit })`: an undirected breadth-first walk over a `GraphReader` port. Depth is capped at 2 and `limit` bounds the node count; it returns nodes with their depth, the edges seen, and whether it was `truncated`.
- `toCsr(walk)`: the walked sub-graph as undirected CSR typed arrays (parallel edges add their weights), transferable to a worker thread.
- `personalizedPageRank(csr, seed, { damping, maxIterations, tolerance })`: power iteration of `r ← (1 − d)·s + d·Pᵀr` (HippoRAG defaults d = 0.5, 30 iterations, 1e-6); dangling mass returns to the seed.
- `communities(csr)`: label propagation, ties to the smallest label; the on-demand stand-in for theme communities until phase 8.

## Invariants

- Deterministic: the same graph and seed give the same scores and labels (sorted CSR neighbours, index-order visits).
- The package knows no keys. The memory engine stores edges under `m/(user, 'g', 'out'|'in', src, relation, dst)` and supplies the reader.

Emits no metrics.
