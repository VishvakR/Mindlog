# Evaluations

Results of the AI evaluation harness in `python/evals` (PLAN 22.7), from phase 6 onwards. Each run is written to `docs/evals/<date>.md`, with its configuration, seeds and model ids, so it can be reproduced.

Suites: LongMemEval and LoCoMo accuracy, retrieval ablations (recall@k, MRR per retriever and fusion), conflict detection (precision / recall / F1 at θ_c), semantic cache (hit rate, false-positive rate, tokens saved), packing (accuracy vs token budget) and forgetting (old-but-important facts after N sessions).
