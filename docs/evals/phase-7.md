# Phase 7 evals: conflict detection

- Pairs: 320 (`python/evals/src/evals/conflict_pairs.py`, hand-written profiles: contradict, entail, neutral same-person facts, and dated changes).
- Node config: {'threshold': 0.95, 'minSimilarity': 0.5, 'policy': 'quarantine_new'}.

## End to end (each pair in its own scope)

| precision | recall | F1 | raised: contradict | entail | neutral | change | change superseded |
|---|---|---|---|---|---|---|---|
| 0.867 | 0.98 | **0.92** | 0.98 | 0.04 | 0.11 | 0.0 | 1.0 |

## NLI sweep (model service directly, without the temporal pairs)

Best on all pairs: agg max, gate 0.5, theta 0.95, precision 0.875, recall 0.98, f1 0.925

Held out (chosen on even pairs, scored on odd ones): agg max, gate 0.5, theta 0.95, precision 0.961, recall 0.98, f1 0.97

| label | pairs | mean max contradiction | mean cosine |
|---|---|---|---|
| contradict | 100 | 0.997 | 0.733 |
| entail | 100 | 0.04 | 0.9 |
| neutral | 100 | 0.364 | 0.53 |

| agg | gate | θ | precision | recall | F1 |
|---|---|---|---|---|---|
| max | 0.0 | 0.5 | 0.685 | 1.0 | 0.813 |
| max | 0.0 | 0.7 | 0.725 | 1.0 | 0.84 |
| max | 0.0 | 0.8 | 0.741 | 1.0 | 0.851 |
| max | 0.0 | 0.9 | 0.775 | 1.0 | 0.873 |
| max | 0.3 | 0.5 | 0.685 | 1.0 | 0.813 |
| max | 0.3 | 0.7 | 0.725 | 1.0 | 0.84 |
| max | 0.3 | 0.8 | 0.741 | 1.0 | 0.851 |
| max | 0.3 | 0.9 | 0.775 | 1.0 | 0.873 |
| max | 0.4 | 0.5 | 0.694 | 1.0 | 0.82 |
| max | 0.4 | 0.7 | 0.735 | 1.0 | 0.847 |
| max | 0.4 | 0.8 | 0.752 | 1.0 | 0.858 |
| max | 0.4 | 0.9 | 0.781 | 1.0 | 0.877 |
| max | 0.5 | 0.5 | 0.766 | 0.98 | 0.86 |
| max | 0.5 | 0.7 | 0.797 | 0.98 | 0.879 |
| max | 0.5 | 0.8 | 0.817 | 0.98 | 0.891 |
| max | 0.5 | 0.9 | 0.831 | 0.98 | 0.899 |
| min | 0.0 | 0.5 | 0.778 | 0.98 | 0.867 |
| min | 0.0 | 0.7 | 0.802 | 0.97 | 0.878 |
| min | 0.0 | 0.8 | 0.814 | 0.96 | 0.881 |
| min | 0.0 | 0.9 | 0.816 | 0.93 | 0.869 |
| min | 0.3 | 0.5 | 0.778 | 0.98 | 0.867 |
| min | 0.3 | 0.7 | 0.802 | 0.97 | 0.878 |
| min | 0.3 | 0.8 | 0.814 | 0.96 | 0.881 |
| min | 0.3 | 0.9 | 0.816 | 0.93 | 0.869 |
| min | 0.4 | 0.5 | 0.778 | 0.98 | 0.867 |
| min | 0.4 | 0.7 | 0.802 | 0.97 | 0.878 |
| min | 0.4 | 0.8 | 0.814 | 0.96 | 0.881 |
| min | 0.4 | 0.9 | 0.816 | 0.93 | 0.869 |
| min | 0.5 | 0.5 | 0.85 | 0.96 | 0.901 |
| min | 0.5 | 0.7 | 0.864 | 0.95 | 0.905 |
| min | 0.5 | 0.8 | 0.87 | 0.94 | 0.904 |
| min | 0.5 | 0.9 | 0.875 | 0.91 | 0.892 |
