# ADR-0015: Conflict detection before commit, quarantine-new by default

- Status: accepted
- Date: 2026-10-30
- PLAN: 13.2 (semantic conflict detection), 13.4 (provenance and quarantine), 12.3 (stage 10), 6.1 (commands 24–25)
- References: [graphiti.md](../references/graphiti.md), [cognee.md](../references/cognee.md)

## Context

Two agents can store contradicting facts about a user ("is vegetarian" / "eats steak every day"). Cognee detects contradictions after storage with an LLM; Graphiti invalidates older facts by their validity dates. Mindlog decides on the leader before commit, with a local NLI model, and makes the decision part of the replicated command so every replica and agent sees the same outcome.

## Decision

- **Stage 10, `detect-conflicts`**, runs after `link-notes` for each new `semantic` fact. It needs the `nli` capability; without it the stage is skipped and the commit is not delayed (degraded mode).
- **Candidates**: the 5 most similar live `semantic` memories of the scope (and its ancestors), plus up to 5 that share an entity with the fact. A candidate is compared only if its embedding's cosine to the new fact is at least **0.5** (`memory.conflicts.minSimilarity`): the NLI model calls many unrelated facts about the same person contradictions (see Tuning).
- **Temporal rule** (Graphiti): when both facts have a `validFrom` and their windows do not overlap, the pair is history and NLI is skipped. When NLI finds a contradiction and the older fact is open-ended while the new one starts later, the older gets `validTo = new.validFrom` (a supersede, carried in the command) instead of a conflict.
- **NLI** runs on (existing, new) and (new, existing). The service returns the top label and its probability, so a pair contradicts when either direction's label is `contradiction` with score ≥ θ_c (default **0.95**, `memory.conflicts.threshold`); it is a duplicate when the (existing, new) label is `entailment` with score ≥ 0.90: the new fact links `supports` to the old one and its importance is halved.
- **Conflict record** `m/(user,'k',id)` → `MemoryConflict { a (existing), b (new), scores, detectedAt, status, policy, origin, resolution }`, and `m/(user,'ko',id)` while open. The leader decides ids and outcome; `MemoryCommit` carries `conflicts` and `supersede`, and apply writes them with the memories.
- **Policies** (`memory.conflicts.policy`, default **`quarantine_new`**):
  - `quarantine_new`: the new fact is stored quarantined (out of recall) and the conflict stays open.
  - `newest_wins`: the old fact gets `validTo` now; the conflict is stored as resolved (`keep b`).
  - `ask_human`: both stay in recall; the conflict stays open.
  - `prefer_verified`: when exactly one side is `verified` it wins as in `newest_wins`; otherwise `quarantine_new`.
- **Resolution** (`ConflictResolve`, body 24; `MEM.RESOLVE id KEEP a|b|both [VALID_FROM t]`): the loser gets `validTo` (never deletion) and the winner leaves quarantine. `both` keeps both; with `VALID_FROM t` it records a change over time (`a.validTo = t`, `b.validFrom = t`).
- **Validity and recall**: `validFrom`/`validTo` are world time in ms. Recall returns facts valid now by default; `VALID_AT t` asks for another time. A superseded fact therefore stays indexed and answers `VALID_AT` queries about the past.
- **Trust changes** (`MemoryTrust`, body 25; `MEM.TRUST id verified|normal|quarantined`) rewrite the record and its vector row, which copies trust for filtering.
- Change events: the change feed reports `conflict.raised` and `conflict.resolved` from the applied commands (PLAN 13.5).

## Tuning

Measured on 320 pairs built from hand-written personal-fact profiles (`python/evals`, `--suite conflicts`; results in `docs/evals/phase-7.md`) with the shipped DeBERTa-v3-xsmall NLI model and MiniLM embeddings:

- The first defaults (θ_c 0.80, no similarity gate) raised a conflict for 30% of pairs of unrelated facts about the same person ("works at Acme" against "eats steak every weekend"). End-to-end F1 was 0.855 (precision 0.746, recall 1.0).
- The sweep's best setting is a 0.5 cosine gate and θ_c 0.95 (max over the two directions). End to end that gives F1 0.92 (precision about 0.87, recall 0.98). Chosen on half the pairs, the same setting scores F1 0.97 on the other half.
- The set is ours and small, so these numbers say the gate and threshold help, not how the model does on real dialogue.

## Alternatives considered

- **Detect after commit in a job** (Cognee): replicas and agents would see the contradicting fact before the decision.
- **`newest_wins` as the default**: silently lets a wrong agent overwrite a user's facts; quarantine keeps the new fact visible to review without letting it into recall.
- **Asking the service for the full probability vector**: changes the gRPC contract for little gain; with θ_c ≥ 0.5 a probability over θ_c is the top label anyway.

## Consequences

- One NLI call per remember with candidates (2 × up to 10 pairs, micro-batched by the service).
- The policy is configured per node, not per scope; a per-scope policy record is future work.
- Quality is measured on a labelled set of ~300 pairs in `python/evals` (`--suite conflicts`), which also sweeps θ_c.
