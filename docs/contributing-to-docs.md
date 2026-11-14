---
description: How this documentation is organised, built and published with GitBook.
---

# Contributing to the docs

## Layout

The documentation lives in [`docs/`](https://github.com/VishvakR/Mindlog/tree/main/docs) and is published with **GitBook Git Sync**. The repository root's `.gitbook.yaml` points GitBook at `docs/`:

```yaml
root: ./docs/
structure:
  readme: README.md      # the landing page
  summary: SUMMARY.md    # the navigation
```

| Path | Contents |
|---|---|
| `README.md`, `SUMMARY.md` | Landing page and table of contents. A page that is not listed in `SUMMARY.md` is not published |
| `overview/`, `getting-started*`, `guides/`, `sdks/` | User-facing pages |
| `api/`, `reference/` | Reference. `api/mcp-tools.md` and `api/resp-compatibility.md` are checked by tests against the code |
| `architecture/`, `design.md`, `adr/` | Design and decisions |
| `operations/`, `runbooks/`, `slo.md` | Operating Mindlog |
| `diagrams/` | Diagram source (`build.py`, `roughen.py`) and the embedded Excalifont |
| `.gitbook/assets/` | Images: generated diagram SVGs and dashboard screenshots |
| `PLAN.md`, `phases/` | Internal planning and phase evidence; not in the navigation |

## Writing

* Markdown with GitBook blocks: `{% hint style="info|warning" %}`, `{% tabs %}` / `{% tab title="…" %}`, `{% stepper %}` / `{% step %}`, `{% code title="…" %}`. Each page starts with front matter carrying a one-line `description`.
* Link to other pages with relative paths. Link to files outside `docs/`, or to pages not in `SUMMARY.md`, with absolute GitHub URLs (`https://github.com/VishvakR/Mindlog/blob/main/…`).
* Facts come from the code, not from the plan: defaults from `packages/core/src/config/config-schema.ts`, commands from `packages/adapter-resp/commands/*.json`, tools from `packages/adapter-mcp/src`, errors from `packages/core/src/errors/error-codes.ts`.
* Never call a feature "first" or "unique". Compare with prior art instead (see [Why Mindlog](overview/why-mindlog.md)).

## Diagrams

Diagrams are hand-drawn in the Excalidraw style, generated from Python, and committed as SVG:

```bash
uv run --no-project python docs/diagrams/build.py              # all figures
uv run --no-project python docs/diagrams/build.py recall jobs  # some
```

* Each `fig_*` function in `build.py` draws one figure with the `Canvas` from `roughen.py`: rough, double-stroked shapes, orthogonal connectors and masked labels. The output is seeded, so a rebuild with no changes is byte-identical.
* Excalifont (SIL Open Font License) is embedded in each SVG, so figures render the same through GitBook's image tag.
* Keep each figure small: at most 9 nodes and 12 arrows, with 1–2 accent (orange) elements for the point of the figure.

## Checks

```bash
pnpm vitest run packages/adapter-mcp/test/mcp-server.test.ts            # every MCP tool documented
pnpm vitest run packages/adapter-resp/test/commands/command-spec.test.ts # every RESP command documented
```

## Publishing with GitBook

One-time setup by a maintainer:

1. Create a GitBook organization (the free plan works; open-source projects can apply for the community plan) and a space named **Mindlog**.
2. In the space, open **Configure → Git Sync**, choose **GitHub**, install the GitBook GitHub app on `VishvakR/Mindlog` only, and select the branch (`main`).
3. For the first sync choose **GitHub → GitBook**. GitHub stays the source of truth. Edits made in the GitBook editor are committed back to the branch, so review them as pull requests.
4. Create a **docs site**, add the space, and publish it as **public**.
5. Under site customization, set the logo and favicon, the primary colour, header links (GitHub, Changelog), and turn on search and AI answers.
6. Optional: a custom domain (a DNS `CNAME`); and upload `docs/api/openapi.json` as an OpenAPI specification to get interactive API blocks.

After that, every merge to `main` updates the published docs.
