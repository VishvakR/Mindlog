# Contributing

## Before you start

- Read the system design ([`docs/design.md`](docs/design.md)) and the ADRs ([`docs/adr/`](docs/adr/README.md)) that cover the area you change. A change to a decision an ADR records needs a new ADR (template `docs/adr/0000-template.md`).
- Node.js 24+, pnpm 10 (`corepack enable`), and [uv](https://docs.astral.sh/uv/) for all Python work.

## Rules the code enforces

- Layers point downward only (interfaces → application → domain → replication → storage → core). ESLint boundary rules and `madge --circular` fail the build otherwise; fix the design, not the rule.
- State machine `apply` is deterministic: no `Date.now()`, `Math.random()`, network, filesystem or model calls. Use the command's HLC, and seed randomness from the log index.
- Raft indexes, terms, HLC timestamps and versions are `bigint`.
- Expected failures return `Result`; codes come from the one error table in `@mindlog/core`.
- Every port has a production adapter, an in-memory fake, and a shared contract test.

## Tests a change needs

| You touched | Add |
|---|---|
| Pure logic (encoders, parsers, scoring, rules) | Unit and fast-check property tests |
| A port or adapter | The shared contract suite, on both the fake and the real adapter |
| Raft, multiraft, statemachine, storage, branching | A simulator scenario; failing seeds become regression tests |
| RESP commands | Compatibility tests with ioredis and redis-py, and the row in `docs/api/resp-compatibility.md` |
| MCP tools | The section in `docs/api/mcp-tools.md` (a test checks it) |
| Memory quality | An eval run, with results committed to `docs/evals/` |

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test
cd python && uv run ruff check && uv run ruff format --check && uv run mypy model_service && uv run pytest
```

## Commits and pull requests

- Small [Conventional Commits](https://www.conventionalcommits.org) with a scope from `commitlint.config.js` (`feat(raft): add PreVote`). Bodies wrap at 100 characters; `pnpm lint:commits` checks them.
- One logical change per commit, with its tests.
- Pull requests follow [the template](.github/pull_request_template.md): what, why (PLAN or ADR link), tests, risks.
- A new dependency needs a reason in the pull request, and `pnpm audit` / `pip-audit` must stay clean.
