# Model service down

**Symptom.**
- Memory responses carry `degraded: true`.
- `mindlog_memory_degraded_total` and `mindlog_models_errors_total` rise.
- Recall quality drops; KV traffic is unaffected.

**Confirm.**
- Check the sidecar: `docker compose ps model-service`, or the process on `models.endpoint` (default `127.0.0.1:50051`).
- The node logs breaker transitions; the breaker opens after `models.breakerFailures` failures.

**Fix**
1. Restart the model service (`uv run python -m model_service`, or `docker compose up -d model-service`). Check that the models are present in `python/model_service/models/`.
2. Nothing else is needed. Writes made while it was down were stored raw, with `memory.enrich` jobs queued. The breaker probes again after `models.breakerOpenMs`.

**Verify.**
- `degraded` disappears from new responses.
- `mindlog_jobs_queue_depth_count` drains back to normal (dashboard Jobs page).
- `test/integration/degraded.test.ts` covers this path.

**Record.** The outage duration, how many enrichment jobs were queued, and any dead-lettered jobs.
