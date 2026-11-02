# Phase 8: sleep-time consolidation on LongMemEval

Stratified LongMemEval_s sample of 100 (seed 6), turns stored per session; in both passes a derived memory (an enrichment fact or a sleep-time summary) counts as a source turn only if it carries one of that turn's sentences.

## Retrieval (turn level)

| recipe | recall_any@10 before | after | NDCG@10 before | after |
|---|---|---|---|---|
| hybrid | 0.950 | 0.910 | 0.746 | 0.702 |
| hybrid_ppr | 0.940 | 0.910 | 0.717 | 0.702 |
| full | 0.930 | 0.910 | 0.741 | 0.685 |

## Packing (`full`): evidence packed and tokens used per budget

| budget | evidence before | after | tokens before | after |
|---|---|---|---|---|
| 250 | 0.450 | 0.430 | 245 | 244 |
| 500 | 0.580 | 0.680 | 493 | 491 |
| 1000 | 0.740 | 0.760 | 991 | 978 |
| 2000 | 0.950 | 0.920 | 1988 | 1916 |
| 4000 | 0.990 | 0.940 | 3803 | 2834 |

Consolidation: 3 rounds, 467 dead jobs.
