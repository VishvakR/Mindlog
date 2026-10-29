# ADR-0011: Retrieval fusion, scoring and recall recipes

- Status: accepted
- Date: 2026-10-29
- PLAN: 11.3 (PPR), 12.4 (recall pipeline), 12.5 (final scoring), 13.6 (packing)
- References: [hipporag.md](../references/hipporag.md), [lightrag.md](../references/lightrag.md), [mem0.md](../references/mem0.md), [graphiti.md](../references/graphiti.md)

## Context

Phase 5 recall runs three retrievers (vector, keyword, entity), fuses them with unweighted RRF, scores with the PLAN 12.5 formula and packs greedily. Phase 6 adds Personalized PageRank, theme retrieval, a cross-encoder rerank, MMR and budget-aware packing, and must show in an eval harness which of them help. Retriever scores are on different scales (cosine, BM25, mention counts, PageRank mass), so they cannot be added directly. Every stage must keep working when the model service is down (PLAN 21).

## Decision

- **Fusion is weighted RRF** over ranks only: `rrf(d) = Σ_r w_r / (60 + rank_r(d))`. Raw scores stay in `signals` for explain, never in fusion.
- **Query routing** (`classifyQuery`) is a heuristic, no model: `multihop` when the query names ≥ 2 entities, `broad` when it names none and has a broad cue ("summarize", "overall", "what do you know", …) or a plural-theme pattern, else `specific`. Weights: theme 1.5 for broad, ppr 1.2 for multihop, everything else 1.0. The theme retriever runs only for broad queries.
- **PPR** follows HippoRAG: an undirected graph of entity and memory nodes (memory–entity mentions, entity–entity edges, memory–memory `related` links), built within 2 hops of the seeds and capped at 5,000 nodes; entity seeds are the query entities weighted by `1 / mentions(e)` (top 5); memory seeds are min-max normalised vector scores × 0.05; damping 0.5, ≤ 30 iterations or ‖Δ‖₁ < 1e-6. The iteration runs in a worker thread (`PprRunner` port); no seed means the retriever returns nothing.
- **Rerank** (optional, `needs: 'rerank'`) scores the top 50 fused candidates with the cross-encoder; the min-max normalised rerank score replaces the normalised fused score as `relevance` in the final score. Model down → skipped, run marked degraded.
- **Final score** stays PLAN 12.5 (`0.6 rel + 0.15 recency + 0.15 importance + 0.10 retention + 0.05 verified`).
- **MMR** (λ = 0.7) reorders the scored list with cosine similarity of stored vectors, falling back to token Jaccard for memories without a vector.
- **Recipes** are named, not flags (CLAUDE.md 3.4): `rag` (vector only, relevance only, no MMR), `vector` (vector + full scoring), `hybrid` (vector, keyword, entity), `hybrid_ppr` (+ ppr), `full` (+ theme, rerank, MMR; the default). Requests pick a recipe; the eval harness compares them.

## Alternatives considered

- **Score normalisation and weighted sums** (Mem0 `score_and_rank`): sensitive to each retriever's score distribution and to outliers; RRF needs no calibration and is the PLAN choice.
- **LLM query classification** (LightRAG keywords): a model call on every recall, and no LLM is guaranteed offline.
- **Whole-graph PPR**: latency grows with the scope; the 2-hop cap bounds it and HippoRAG's mass stays near the seeds at d = 0.5.
- **Per-request feature flags** instead of recipes: combinatorial, and evals could not name what they measured.

## Consequences

- Recall emits per-retriever lists and per-signal scores when `explain` is set; the dashboard and the eval harness use them.
- Weights, d and the seed weight are tuned on the eval sets (PLAN 22.7); the defaults live in `DEFAULT_MEMORY_CONFIG`.
- Revisit routing if evals show broad/multihop misclassification hurting recall; revisit the node cap if PPR p95 exceeds its budget.
