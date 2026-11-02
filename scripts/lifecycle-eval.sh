#!/usr/bin/env bash
# Phase 8 gate (PLAN 24): over 30 simulated days, the forgetting curve beats LRU eviction on
# old-but-important facts, and the hot memory count stays bounded.
# Usage: scripts/lifecycle-eval.sh [days] [important facts] [noise per day]   (defaults 30 40 10)
# BENCH_MODELS=host:port uses a running model service instead of FakeModels.
# EVAL_OUT=path writes the per-day counts as JSON.
set -euo pipefail
cd "$(dirname "$0")/.."
BENCH=1 EVAL_DAYS="${1:-30}" EVAL_IMPORTANT="${2:-40}" EVAL_NOISE="${3:-10}" \
  pnpm exec vitest run test/bench/lifecycle.test.ts --reporter=verbose 2>&1 | grep -E "lifecycle eval|✓|×|FAIL|Error"
