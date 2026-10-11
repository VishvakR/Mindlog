## What

<!-- One or two sentences: what changes. -->

## Why

<!-- Link the PLAN.md section and/or ADR this implements. -->

## Checklist

- [ ] Tests added (unit + property for pure logic; contract suite for ports; simulator scenario for replication changes)
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass (and `uv run pytest` for Python changes)
- [ ] ADR needed? If this makes a significant decision, `docs/adr/NNNN-*.md` is added or updated
- [ ] Docs updated (package README, PLAN/ADR references)
- [ ] Metrics, spans and error mappings added for new request paths
- [ ] Changeset added for versioned packages (`pnpm changeset`)

## Risks

<!-- What could break, and how it is contained. -->
