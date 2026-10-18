# ADR-0016: Model calls only before proposing; results embedded in commands

- Status: accepted
- Date: 2026-10-18
- PLAN: 4.5, 12.2–12.3, 14, 21
- References: [mem0.md](../references/mem0.md), [redis-agent-memory.md](../references/redis-agent-memory.md)

## Context

Models (embeddings, NER, extraction) are not deterministic across hardware, versions and runs, and they are slow. Replicas must reach identical state (CLAUDE.md rules 1–2). A request can arrive at any node.

## Decision

- Model calls happen in the ingestion and recall pipelines on the node that serves the scope's **range leader**, before proposing. Their outputs (vectors, entities, facts, terms) are embedded in the `MemoryCommit` command (ADR-0032). Apply never calls a model.
- A node that does not lead the user's range forwards the whole request to the leader (PLAN 4.5 step 3), which runs the pipeline. Linking (nearest notes, entities) then reads the leader's own, up-to-date indexes.
- The model service is reached through `@mindlog/models-client` with a deadline per call and a circuit breaker. When it is unavailable the pipeline skips model stages, stores the raw text as an episodic memory with an `enrich` job, and answers `degraded: true` (PLAN 21).

## Alternatives considered

- **Models on the receiving node, then forward a prepared command**: linking would need remote index reads; splitting the pipeline across nodes adds a second protocol.
- **Models in apply**: breaks determinism and blocks every replica on inference.

## Consequences

- Leaders do the model work; PD's leader balancing spreads it.
- A leader change mid-request returns `NOT_LEADER`, and the router retries with the same request id, so a commit applies once.
