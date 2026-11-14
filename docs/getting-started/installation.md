---
description: Requirements and the three ways to install Mindlog.
---

# Installation

## Requirements

| Component | Version | Needed for |
|---|---|---|
| Node.js | 24 or newer | The server (`mindlog-server`) |
| pnpm | 10 (`corepack enable`) | Building from source |
| uv | any recent | The Python model service and Python SDK |
| Docker with Compose | optional | Container images, clusters and the observability stack |

Mindlog runs on macOS and Linux (x86-64 and arm64). It needs no network access at runtime.

## Option 1: build from source

{% stepper %}
{% step %}
### Clone and build

```bash
git clone https://github.com/VishvakR/Mindlog.git
cd Mindlog
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles every package and the dashboard. The server entry point is `packages/server/dist/bin.js`.
{% endstep %}

{% step %}
### Put `mindlog-server` on your path (optional)

```bash
alias mindlog-server="node $PWD/packages/server/dist/bin.js"
mindlog-server --version
```

The rest of these docs write `mindlog-server`; `node packages/server/dist/bin.js` is the same thing.
{% endstep %}

{% step %}
### Start a node

```bash
mindlog-server --single-node --data-dir ./data
```

RESP listens on `:6379`, HTTP and the dashboard on `:8090`, MCP on `127.0.0.1:8765`. `pnpm dev` does the same after a build.
{% endstep %}
{% endstepper %}

## Option 2: Docker Compose

The `dev` profile runs one node, the model service, Prometheus, Grafana and Jaeger:

```bash
docker compose --profile dev up --build
```

| Service | Address |
|---|---|
| RESP | `localhost:6379` |
| Dashboard and REST | `http://localhost:8090/_/` |
| Grafana | `http://localhost:3000` |
| Jaeger | `http://localhost:16686` |
| Prometheus | `http://localhost:9091` |

Create a dashboard account with the node stopped:

```bash
docker compose --profile dev run --rm mindlog superuser upsert you@example.com 'a long password' --data-dir /data
```

Stop everything with `docker compose --profile dev down` (add `-v` to delete the data volume).

## Option 3: release images

Tagged releases publish two images to the GitHub Container Registry:

```bash
docker pull ghcr.io/vishvakr/mindlog:1.0.0
docker pull ghcr.io/vishvakr/mindlog-model-service:1.0.0
```

The release also attaches the SDK packages (an npm tarball of `@mindlog/sdk` and a wheel of the Python `mindlog` package) to the GitHub release.

## Optional: the model service

Without models, memory still works in [degraded mode](../guides/memory/remember.md#degraded-mode): text is stored as-is and recall uses keyword and entity matching. To get fact extraction, embeddings, entity recognition, conflict detection and reranking, run the local model service. See [Run the model service](models.md).

## Next

* Follow the [Quickstart](../getting-started.md).
* Read [Configuration](../reference/configuration.md) to change ports, data directories and features.
