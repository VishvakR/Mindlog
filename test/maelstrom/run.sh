#!/usr/bin/env bash
# Usage: test/maelstrom/run.sh [maelstrom args...]
# Phase 3 gate (PLAN 24): Jepsen Maelstrom lin-kv against 3 Mindlog nodes with
# network partitions. Results land in test/maelstrom/store/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")/../.."
docker build -q -t mindlog:maelstrom-base . >/dev/null
docker build -q -t mindlog-maelstrom test/maelstrom >/dev/null
mkdir -p test/maelstrom/store
docker run --rm -v "$PWD/test/maelstrom/store:/work/store" mindlog-maelstrom "$@" 2>&1 | tee test/maelstrom/store/last-run.log | tail -40
grep -q "Everything looks good" test/maelstrom/store/last-run.log
