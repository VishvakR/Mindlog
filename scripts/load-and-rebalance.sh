#!/usr/bin/env bash
# Usage: scripts/load-and-rebalance.sh [load-mb] [value-bytes]
# Phase 4 gate (PLAN 24): load a 3-node `cluster`, check that ranges split, add node 4 and time how
# long until every node holds a replica count within one of the others (gate: under 10 minutes).
# The plan's 5 GB / 10 min run is scaled down to LOAD_MB (default 128, so 16 ranges of 8 MiB; pass
# 1024 for over a hundred), see docs/phases/phase-4.md. Needs docker, redis-cli and python3. Always tears the cluster down.
set -euo pipefail
cd "$(dirname "$0")/.."
LOAD_MB=${1:-128}
VALUE=${2:-1024}
# 8 MiB ranges split in halves: expect at least 80% of LOAD_MB/8 ranges, three replicas each.
WANT=$(( LOAD_MB / 8 * 3 * 8 / 10 ))
KEYS=$(( LOAD_MB * 1024 * 1024 / (VALUE + 64) ))
compose() { docker compose --profile cluster --profile cluster-join "$@"; }
trap 'compose down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

replicas() { curl -sf "localhost:$1/metrics" | awk '/^mindlog_store_replicas_count/ {print $2}' | head -1; }
http_port() { echo $((8100 + $1)); }

echo "starting 3 nodes"
docker compose --profile cluster up -d --build >/dev/null
until [ "$(redis-cli -p 6391 ping 2>/dev/null)" = PONG ]; do sleep 1; done

echo "loading $KEYS keys of $VALUE bytes (~$LOAD_MB MB)"
python3 - "$KEYS" "$VALUE" <<'PY' | redis-cli -p 6391 --pipe >/dev/null
import sys
keys, size = int(sys.argv[1]), int(sys.argv[2])
val = b"x" * size
out = sys.stdout.buffer
for i in range(keys):
    k = b"load:%09d" % i
    out.write(b"*3\r\n$3\r\nSET\r\n$%d\r\n%s\r\n$%d\r\n%s\r\n" % (len(k), k, size, val))
PY

echo "waiting for ranges to split"
for _ in $(seq 1 120); do
  total=0
  for n in 1 2 3; do total=$(( total + $(replicas "$(http_port $n)" || echo 0) )); done
  echo "  replicas across the 3 nodes: $total"
  [ "$total" -ge "$WANT" ] && break
  sleep 5
done

echo "adding node 4"
start=$(date +%s)
docker compose --profile cluster-join up -d cluster-4 >/dev/null
while true; do
  counts=()
  for n in 1 2 3 4; do counts+=("$(replicas "$(http_port $n)" || echo 0)"); done
  min=${counts[0]}; max=${counts[0]}
  for c in "${counts[@]}"; do [ "$c" -lt "$min" ] && min=$c; [ "$c" -gt "$max" ] && max=$c; done
  elapsed=$(( $(date +%s) - start ))
  echo "  ${elapsed}s replicas per node: ${counts[*]}"
  if [ "$min" -gt 0 ] && [ $(( max - min )) -le 1 ]; then
    echo "balanced after ${elapsed}s"
    [ "$elapsed" -lt 600 ] && echo "gate met (< 600 s)" || { echo "gate missed"; exit 1; }
    break
  fi
  [ "$elapsed" -gt 900 ] && { echo "gave up after 15 minutes"; exit 1; }
  sleep 5
done
