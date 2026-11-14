---
description: Every Prometheus metric Mindlog exports.
---

# Metrics

Each node exports Prometheus metrics at `GET /metrics` on the HTTP port. Names follow `mindlog_<area>_<thing>_<unit>`. The `dev` compose profile ships a Prometheus scrape config and a Grafana dashboard (`deploy/`).

## Requests

| Metric | Type | Meaning |
|---|---|---|
| `mindlog_kv_command_latency_seconds` | histogram | KV command latency, by command |
| `mindlog_kv_command_errors_total` | counter | KV command errors, by code |
| `mindlog_http_request_latency_seconds` | histogram | HTTP request latency, by route |
| `mindlog_http_request_errors_total` | counter | HTTP errors |
| `mindlog_resp_connections_count` | gauge | Open RESP connections |
| `mindlog_resp_connections_accepted_total`, `…_rejected_total` | counter | Connections accepted, refused (over `maxClients`) |
| `mindlog_resp_disconnects_total` | counter | Disconnects, by `reason` (for example `output-limit`) |
| `mindlog_resp_received_bytes_total` | counter | Bytes received |

## Replication and storage

| Metric | Type | Meaning |
|---|---|---|
| `mindlog_raft_term_count`, `mindlog_raft_role_info` | gauge | Current term and role per range |
| `mindlog_raft_commit_index_entries`, `mindlog_raft_applied_index_entries` | gauge | Commit and applied index |
| `mindlog_raft_elections_total` | counter | Elections started |
| `mindlog_raft_commit_latency_seconds` | histogram | Propose to commit |
| `mindlog_raft_proposals_dropped_total` | counter | Proposals dropped (no leader, queue full) |
| `mindlog_raft_snapshots_total` | counter | Snapshots sent and installed |
| `mindlog_raft_replica_failures_total` | counter | Replicas that fail-stopped |
| `mindlog_statemachine_applied_total` | counter | Commands applied |
| `mindlog_statemachine_apply_latency_seconds` | histogram | Apply time per command |
| `mindlog_store_leaders_count`, `mindlog_store_replicas_count` | gauge | Range leaders and replicas on this node |
| `mindlog_transport_sent_messages_total`, `…_dropped_messages_total` | counter | Raft messages between nodes |
| `mindlog_pd_ranges_count`, `mindlog_pd_operators_count` | gauge | Ranges known to the PD, operators running |
| `mindlog_clock_offset_seconds` | gauge | Measured clock offset |
| `mindlog_clock_fenced_info` | gauge | 1 when the node has fenced itself for clock offset |
| `mindlog_kv_expiry_proposed_total`, `mindlog_kv_gc_removed_total` | counter | Replicated expiry and garbage collection |

## Memory engine

| Metric | Type | Meaning |
|---|---|---|
| `mindlog_memory_stage_seconds` | histogram | Time per pipeline stage (`remember` and `recall`) |
| `mindlog_memory_degraded_total` | counter | Requests served in degraded mode |
| `mindlog_memory_ppr_shed_total` | counter | PPR runs skipped under load |
| `mindlog_memory_recall_stats_dropped_total` | counter | Recall statistics dropped (batch full) |
| `mindlog_memory_tier_moves_total` | counter | Moves between hot and cold tiers |
| `mindlog_memory_vector_rebuilds_total` | counter | Vector-cache rebuilds |
| `mindlog_memory_splits_total`, `…_split_moved_total`, `…_split_moved_bytes_total` | counter | Semantic splits |
| `mindlog_models_call_latency_seconds` | histogram | Model service calls, by capability |
| `mindlog_models_errors_total` | counter | Model service errors |
| `mindlog_cache_lookups_total` | counter | Semantic cache lookups, by `result` |
| `mindlog_cache_tokens_saved_total` | counter | Tokens saved by cache hits |
| `mindlog_consolidation_runs_total`, `…_run_seconds` | counter, histogram | Consolidation worker runs |
| `mindlog_consolidation_model_seconds_total` | counter | Model time used by workers |
| `mindlog_consolidation_sleep_merges_total` | counter | Sleep-time branches merged or dropped |
| `mindlog_jobs_queue_depth_count` | gauge | Queued jobs per range |
| `mindlog_jobs_run_seconds` | histogram | Job run time, by kind |

## Tenancy, audit and backups

| Metric | Type | Meaning |
|---|---|---|
| `mindlog_tenant_rate_limited_total` | counter | Requests refused by a rate limit |
| `mindlog_tenant_quota_rejections_total` | counter | Requests refused by a quota |
| `mindlog_tenant_quota_usage_count` | gauge | Sampled usage per tenant and quota |
| `mindlog_audit_written_total`, `mindlog_audit_dropped_total` | counter | Audit records written, dropped |
| `mindlog_backup_ranges_total` | counter | Ranges backed up |
| `mindlog_backup_verify_total` | counter | Backup verifications, by `outcome` |
| `mindlog_eventbus_events_published_total`, `…_handler_errors_total` | counter | In-process events |

Suggested alerts and what to do about them are in the [runbooks](../runbooks/README.md) and [Observability](../operations/observability.md).
