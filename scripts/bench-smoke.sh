#!/usr/bin/env bash
# Phase 1 gate (PLAN 24): redis-benchmark completes against a fresh single node.
# Usage: scripts/bench-smoke.sh [requests] [clients]   (defaults 100000, 50)
# Needs redis-benchmark on PATH (or REDIS_BENCHMARK) and a build (pnpm build).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REQUESTS="${1:-100000}"
CLIENTS="${2:-50}"
PORT="${MINDLOG_BENCH_PORT:-16399}"
BENCH="${REDIS_BENCHMARK:-$(command -v redis-benchmark || true)}"
BIN="$ROOT/packages/server/dist/bin.js"

if [ -z "$BENCH" ]; then
  echo "redis-benchmark not found; install redis or valkey, or set REDIS_BENCHMARK" >&2
  exit 1
fi
if [ ! -f "$BIN" ]; then
  echo "server not built; run pnpm build" >&2
  exit 1
fi

DATA="$(mktemp -d "${TMPDIR:-/tmp}/mindlog-bench.XXXXXX")"
LOG="$DATA/server.log"
node "$BIN" --single-node --host 127.0.0.1 --port "$PORT" --http-port 0 --data-dir "$DATA/data" --log-level warn >"$LOG" 2>&1 &
SERVER=$!
cleanup() {
  kill -TERM "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  rm -rf "$DATA"
}
trap cleanup EXIT

# Wait with bash's /dev/tcp: redis-benchmark 7.0 (Ubuntu) hangs forever if it cannot connect.
for _ in $(seq 1 100); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then break; fi
  sleep 0.1
done
if ! (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "server did not start on port $PORT:" >&2
  cat "$LOG" >&2
  exit 1
fi

echo "mindlog $(node "$BIN" --version | awk '{print $2}') · node $(node --version) · $(uname -sm)"
# Keep only the summary lines (-q still prints \r progress when not on a TTY).
summary() { tr '\r' '\n' | grep 'requests per second'; }

echo "redis-benchmark -t set,get,incr,lpush,hset,zadd -n $REQUESTS -c $CLIENTS -q"
"$BENCH" -p "$PORT" -t set,get,incr,lpush,hset,zadd -n "$REQUESTS" -c "$CLIENTS" -q | summary
echo "pipelined (-P 16):"
"$BENCH" -p "$PORT" -t set,get -n "$REQUESTS" -c "$CLIENTS" -P 16 -q | summary
