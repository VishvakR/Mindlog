#!/usr/bin/env bash
# Phase 10 gate (PLAN 24): semantic-split recall@10 within 5% of one range, on LongMemEval.
# Runs the same sample twice on fresh single nodes: every scope in one range, then every scope
# split by k-means at `max-memories` (so about 255 memories become ~4 clusters, and recall
# searches the 2 nearest). Writes docs/evals/phase-10-{single,split}.{json,md}.
# Usage: scripts/split-eval.sh [questions] [max-memories]   (defaults 100 100)
# Needs `pnpm build`, the models in python/model_service/models/, and ports 6390, 8099, 50051 free.
set -euo pipefail
cd "$(dirname "$0")/.."
N=${1:-100}
AT=${2:-100}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/mindlog-split-eval.XXXXXX")
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
up() { for _ in $(seq 1 600); do (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0; sleep 1; done; return 1; }

(cd python && uv run python -m model_service) >"$WORK/models.log" 2>&1 &
PIDS+=($!)
up 50051 || { echo "model service did not start"; tail -20 "$WORK/models.log"; exit 1; }

run() {
  local name=$1 split=$2
  shift 2
  MINDLOG_MODELS__ENDPOINT=127.0.0.1:50051 \
    MINDLOG_MEMORY__SPLIT__MAX_MEMORIES="$split" \
    MINDLOG_MEMORY__CONSOLIDATION__ENABLED=false \
    node packages/server/dist/bin.js --single-node --port 6390 --http-port 8099 \
    --data-dir "$WORK/$name" >"$WORK/$name.log" 2>&1 &
  local node=$!
  up 6390 || { echo "node did not start"; tail -20 "$WORK/$name.log"; exit 1; }
  (cd python && uv run python -m evals.run --suite longmemeval --n "$N" \
    --recipes vector hybrid hybrid_ppr --no-packing --out "../docs/evals/phase-10-$name" "$@")
  kill "$node"
  wait "$node" 2>/dev/null || true
}

run single 0
run split "$AT" --split
echo "split-eval: wrote docs/evals/phase-10-single.* and phase-10-split.*"
