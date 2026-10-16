#!/usr/bin/env bash
# Usage: scripts/sim.sh <seeds> [shards] [first-seed]
# Runs <seeds> simulator seeds from [first-seed] (default 1) split across <shards> parallel vitest
# processes (PLAN 22.2; the phase 3 gate is 10,000). Prints each failing seed.
set -euo pipefail
cd "$(dirname "$0")/.."
SEEDS=${1:-10000}
SHARDS=${2:-4}
FIRST=${3:-1}
PER=$(( (SEEDS + SHARDS - 1) / SHARDS ))
LOGS=$(mktemp -d)
for ((i = 0; i < SHARDS; i++)); do
  OFFSET=$(( i * PER ))
  COUNT=$(( OFFSET + PER > SEEDS ? SEEDS - OFFSET : PER ))
  SIM_FROM=$(( FIRST + OFFSET )) SIM_SEEDS=$COUNT pnpm exec vitest run test/sim/sim.test.ts >"$LOGS/$i.log" 2>&1 &
done
FAILED=0
for job in $(jobs -p); do wait "$job" || FAILED=1; done
grep -ho "replay: SIM_SEED=[0-9]*[^\"]*" "$LOGS"/*.log | sort -u || true
if [ "$FAILED" = 0 ]; then echo "sim: $SEEDS seeds passed across $SHARDS shards"; else echo "sim: failures above"; exit 1; fi
