#!/usr/bin/env bash
# Usage: scripts/chaos/partition.sh <service> [seconds]
# Cuts one node of the `chaos` cluster off the network, then heals it.
set -euo pipefail
cd "$(dirname "$0")/../.."
container=$(docker compose --profile chaos ps -q "$1")
network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$container")
echo "isolating $1 from $network for ${2:-10}s"
docker network disconnect "$network" "$container"
sleep "${2:-10}"
docker network connect --alias "$1" "$network" "$container"
echo "healed $1"
