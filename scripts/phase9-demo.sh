#!/usr/bin/env bash
# Phase 9 gate (PLAN 24): the todo app end to end on one local node, through the SDK
# (examples/todo-app/src/demo.ts). DEMO_OTP=1 also turns on OTP with the console mailer.
# Removes its data directory afterwards. Exits non-zero if any check fails.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8097}
RESP=${RESP:-6397}
MCP=${MCP:-8797}
DATA=$(mktemp -d)
LOG="$DATA/node.log"
ADMIN_EMAIL=demo-admin@example.com
ADMIN_PASSWORD='phase nine demo password'
NODE_PID=
cleanup() {
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null && wait "$NODE_PID" 2>/dev/null || true
  rm -rf "$DATA"
}
trap cleanup EXIT

pnpm build >/dev/null
BIN=packages/server/dist/bin.js
node "$BIN" superuser upsert "$ADMIN_EMAIL" "$ADMIN_PASSWORD" --data-dir "$DATA/db" >/dev/null
KEY=$(node "$BIN" apikey create --tenant default --name assistant --data-dir "$DATA/db" | grep -o 'mlk_[A-Za-z0-9_-]*' | head -1)
[ -n "$KEY" ] || { echo "phase9-demo: could not create an API key" >&2; exit 1; }

export MINDLOG_COLLECTIONS__MIGRATIONS_DIR=examples/todo-app/migrations
export MINDLOG_LISTEN__MCP__HTTP__PORT=$MCP
if [ "${DEMO_OTP:-}" = 1 ]; then
  export MINDLOG_MAIL__MODE=console DEMO_OTP_LOG=$LOG
fi
node "$BIN" --single-node --port "$RESP" --http-port "$PORT" --data-dir "$DATA/db" >"$LOG" 2>&1 &
NODE_PID=$!
for _ in $(seq 1 100); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/ready" || true)" = 200 ] && break
  sleep 0.2
done

(cd examples/todo-app && MINDLOG_URL="http://127.0.0.1:$PORT" MINDLOG_API_KEY="$KEY" \
  ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" node src/demo.ts)
