#!/usr/bin/env bash
# Phase 5 gate (PLAN 24): recall p95 < 150 ms with 10K memories in one scope.
# Usage: scripts/bench-recall.sh [memories] [queries]   (defaults 10000, 300)
# BENCH_MODELS=host:port uses a running model service instead of FakeModels over gRPC.
set -euo pipefail
cd "$(dirname "$0")/.."
BENCH=1 BENCH_MEMORIES="${1:-10000}" BENCH_QUERIES="${2:-300}" \
  pnpm exec vitest run test/bench/recall.test.ts --reporter=verbose 2>&1 | grep -E "recall benchmark|✓|×|FAIL|Error"
