#!/usr/bin/env bash
# Phase 5 gate (PLAN 24): the memory demo with networking disabled except between the containers.
# Builds the images (the only step that needs the internet), creates an API key offline, starts
# the node and the model service on an `internal: true` network, proves no route out exists,
# and runs the two-session demo agent; then stops the model service and runs it again (degraded:
# raw memories, keyword recall). Cleans up containers, network and volume afterwards.
# Models must be in python/model_service/models/ (download_models.py), or the build fetches them.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose --profile offline)
cleanup() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${COMPOSE[@]}" build offline-models offline-mindlog offline-demo
KEY=$("${COMPOSE[@]}" run --rm --no-deps offline-mindlog \
  apikey create --tenant default --user demo --name offline-demo --data-dir /data \
  | grep -o 'mlk_[A-Za-z0-9_-]*' | head -1)
[ -n "$KEY" ] || { echo "offline-demo: could not create an API key" >&2; exit 1; }
"${COMPOSE[@]}" up -d --wait offline-models offline-mindlog

echo "offline-demo: checking that the network has no route out"
"${COMPOSE[@]}" run --rm --no-deps offline-demo -c '
import socket, sys
for host, port in [("1.1.1.1", 443), ("8.8.8.8", 53)]:
    try:
        socket.create_connection((host, port), timeout=3).close()
    except OSError:
        continue
    sys.exit(f"reached {host}:{port}: the network is not offline")
try:
    socket.getaddrinfo("huggingface.co", 443)
    sys.exit("resolved huggingface.co: the network is not offline")
except OSError:
    pass
print("no route out: ok")
'

"${COMPOSE[@]}" run --rm --no-deps -e MINDLOG_API_KEY="$KEY" offline-demo

echo "offline-demo: stopping the model service (degraded mode, PLAN 21)"
"${COMPOSE[@]}" stop offline-models
"${COMPOSE[@]}" run --rm --no-deps -e MINDLOG_API_KEY="$KEY" offline-demo
