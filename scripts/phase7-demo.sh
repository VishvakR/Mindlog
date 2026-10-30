#!/usr/bin/env bash
# Phase 7 gate (PLAN 24): the multi-agent demo, offline. Two agents (two API keys) write
# contradicting facts, a conflict is raised, a human resolves it through the dashboard's REST
# endpoint, an agent tries a plan on a branch and merges it, and time travel shows memory before
# the merge (python/demo_agents/src/demo_agents/phase7.py). Uses the `offline` profile (no route
# out); cleans up containers, network and volume afterwards. Exits non-zero if any check fails.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose --profile offline)
ADMIN_EMAIL=demo-admin@example.com
ADMIN_PASSWORD='phase seven demo password'
cleanup() { "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${COMPOSE[@]}" build offline-models offline-mindlog offline-demo
cli() { "${COMPOSE[@]}" run --rm --no-deps offline-mindlog "$@" --data-dir /data; }
key() { cli apikey create --tenant default --user demo --name "$1" | grep -o 'mlk_[A-Za-z0-9_-]*' | head -1; }
cli superuser upsert "$ADMIN_EMAIL" "$ADMIN_PASSWORD" >/dev/null
KEY_A=$(key planner)
KEY_B=$(key assistant)
[ -n "$KEY_A" ] && [ -n "$KEY_B" ] || { echo "phase7-demo: could not create API keys" >&2; exit 1; }
"${COMPOSE[@]}" up -d --wait offline-models offline-mindlog

"${COMPOSE[@]}" run --rm --no-deps \
  -e MINDLOG_API_KEY="$KEY_A" -e MINDLOG_API_KEY_B="$KEY_B" \
  -e MINDLOG_HTTP_URL=http://offline-mindlog:8090 \
  -e MINDLOG_ADMIN_EMAIL="$ADMIN_EMAIL" -e MINDLOG_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  offline-demo -m demo_agents.phase7
