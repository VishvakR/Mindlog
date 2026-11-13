#!/usr/bin/env bash
# Writes docs/api/openapi.json from a throwaway single node (run `pnpm build` first).
# Usage: scripts/openapi.sh [http-port]
set -euo pipefail
cd "$(dirname "$0")/.."
port="${1:-18099}"
dir="$(mktemp -d)"
node packages/server/dist/bin.js --single-node --host 127.0.0.1 --port 0 --http-port "$port" \
  --mcp-port 0 --data-dir "$dir" >"$dir.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$dir" "$dir.log"' EXIT
for _ in $(seq 100); do
  if curl -sf "http://127.0.0.1:$port/api/openapi.json" -o docs/api/openapi.json.tmp; then
    node -e 'const f=process.argv[1];const fs=require("fs");fs.writeFileSync(f.replace(/\.tmp$/,""),JSON.stringify(JSON.parse(fs.readFileSync(f,"utf8")),null,2)+"\n");fs.unlinkSync(f)' docs/api/openapi.json.tmp
    echo "wrote docs/api/openapi.json"
    exit 0
  fi
  sleep 0.2
done
echo "the node did not start; see $dir.log" >&2
exit 1
