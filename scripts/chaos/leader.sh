#!/usr/bin/env bash
# Usage: scripts/chaos/leader.sh   → prints the compose service that leads (chaos profile).
set -euo pipefail
for i in 1 2 3; do
  role=$(redis-cli -p "638$i" CLUSTER.INFO 2>/dev/null | sed -n '/^role$/{n;p;}' || true)
  if [ "$role" = leader ]; then echo "mindlog-$i"; exit 0; fi
done
echo "no leader" >&2
exit 1
