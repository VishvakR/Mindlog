# mindlog-evals

Retrieval evals for Mindlog's memory engine (PLAN 22.7, phase 6). They measure whether recall puts the evidence in its top results, per recall recipe (ADR-0011), and how often the semantic cache answers a different question (ADR-0012). They do not measure answer accuracy: no LLM reads the context or judges answers.

## Run

```bash
cd python
uv run python -m evals.download      # LongMemEval_s (HF, ~280 MB) and LoCoMo into evals/data/ (gitignored)
uv run python -m model_service       # in another shell, real models
MINDLOG_MODELS__ENDPOINT=127.0.0.1:50051 node ../packages/server/dist/bin.js --single-node --port 6390 --data-dir <fresh dir>
uv run python -m evals.run --suite all            # or longmemeval | locomo | cache; --full for all 500 questions
```

Results go to `docs/evals/phase-6.{json,md}`; each suite updates its own part. Ingestion is resumable: the harness keeps memory id → turn id in `evals:map:<scope>` and the next turn in `evals:next:<scope>`, so a stopped run continues where it was. Use a fresh data directory for a fresh run.

## What it does

- **LongMemEval_s**: a seeded sample (default 100, seed 6) stratified by question type, abstention questions excluded. One scope per question; every user turn is stored with `MEM.ADD … KIND episodic` (no extraction). Evidence = turns with `has_answer`.
- **LoCoMo**: the 10 conversations, every turn stored as `speaker: text`; evidence = the `dia_id`s, adversarial questions (category 5) excluded. The data is CC BY-NC 4.0: used locally, never committed.
- **Metrics** (`metrics.py`, LongMemEval's definitions): `recall_any@k`, `recall_all@k` and binary NDCG@k for k = 5, 10, on turns and on sessions. Queries run one at a time, so latencies are per query.
- **Ablations**: recipes `rag` (plain RAG baseline), `vector`, `hybrid`, `hybrid_ppr`, `full`.
- **Packing curve**: `MEM.PACK` at 250–4,000 tokens: share of questions with an evidence turn in the packed context, and tokens used.
- **Cache**: half of LongMemEval's distinct questions are cached; lookups are templated rewordings of them (positives) and the other half (negatives). The false-positive rate is the share of lookups answered with another question's entry, swept over thresholds.

## Limits

- No external baselines (Mem0, Cognee, Redis Agent Memory Server): they need hosted LLMs.
- Cache positives are templated rewordings, not true paraphrases.
- Timestamps of the haystack sessions are not replayed, so recency is the same for every memory.
