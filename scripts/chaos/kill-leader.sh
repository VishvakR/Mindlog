#!/usr/bin/env bash
# Usage: scripts/chaos/kill-leader.sh [restart-after-seconds]
# SIGKILLs the current leader of the `chaos` cluster, then starts it again.
set -euo pipefail
cd "$(dirname "$0")/../.."
leader=$(scripts/chaos/leader.sh)
echo "killing $leader"
docker compose --profile chaos kill -s SIGKILL "$leader"
start=$(date +%s)
until new=$(scripts/chaos/leader.sh 2>/dev/null) && [ "$new" != "$leader" ]; do sleep 0.1; done
echo "new leader $new after $(( $(date +%s) - start ))s"
sleep "${1:-5}"
docker compose --profile chaos start "$leader"
