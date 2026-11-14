---
description: Metrics, traces, logs, health checks, and the dashboards that come with Mindlog.
---

# Observability

## Health checks

| Endpoint | Meaning |
|---|---|
| `GET /health` | The process is up: `{"status":"ok"}` |
| `GET /ready` | The node can serve: `{"status":"ready"}`, or 503 while starting or stopping. The model service is **not** required, since degraded mode still serves |

Use `/ready` for load-balancer and Kubernetes readiness probes, and `/health` for liveness.

## Metrics

Prometheus metrics are at `GET /metrics`. The full list is in [Metrics](../reference/metrics.md). The `dev` compose profile runs Prometheus (`:9091`) and Grafana (`:3000`) with a provisioned Mindlog dashboard; the configs are in `deploy/prometheus` and `deploy/grafana`.

Signals worth alerting on:

| Signal | Metric | Runbook |
|---|---|---|
| Frequent elections | `rate(mindlog_raft_elections_total[5m])` | [Leader flapping](../runbooks/leader-flapping.md) |
| A follower lagging | commit vs applied index gap | [Slow follower](../runbooks/slow-follower.md) |
| A replica fail-stopped | `mindlog_raft_replica_failures_total` | [Disk full](../runbooks/disk-full.md), [Node crash](../runbooks/node-crash.md) |
| Model service failing | `mindlog_memory_degraded_total`, `mindlog_models_errors_total` | [Model service down](../runbooks/model-service-down.md) |
| Clock trouble | `mindlog_clock_offset_seconds`, `mindlog_clock_fenced_info` | [Node crash](../runbooks/node-crash.md) |
| Backpressure | `mindlog_raft_proposals_dropped_total`, `mindlog_jobs_queue_depth_count` | [Slow follower](../runbooks/slow-follower.md) |
| Backups failing | `mindlog_backup_verify_total` with a failed `outcome` | [Restore from backup](../runbooks/restore-from-backup.md) |
| Tenants at their limits | `mindlog_tenant_quota_rejections_total` | [Tenants](../guides/tenants-and-access.md#quotas-and-rate-limits) |

## Traces

OpenTelemetry tracing over OTLP/HTTP is **off** until you set an endpoint, because Mindlog makes no network calls unless asked:

```yaml
observability:
  tracing:
    endpoint: http://jaeger:4318
    sampleRatio: 0.05
```

Spans follow a request through the layers: `resp.command → kv.<cmd> → statemachine.apply → storage.write`, `memory.remember`, `memory.recall` and one span per pipeline stage (`memory.<pipeline>.<stage>`), `cache.lookup`, `cache.store`, and `consolidation.<worker>`. The `dev` compose profile sends traces to Jaeger (`:16686`).

## Logs

Structured JSON logs (pino) go to stdout at `observability.logLevel` (default `info`). Entries carry `traceId`, `tenant` and `rangeId` where they apply, and secrets are redacted. Recent logs are also visible at `GET /api/admin/logs` and on the dashboard **Logs & audit** page.

## Explanations

Decisions that affect data are recorded with an explanation the dashboard shows: the PD scheduler's operators (Cluster page), conflict records (Conflicts), quarantines and trust changes (Memory history), merge rejections (Branches), job failures (Jobs) and authorization refusals (audit log).
