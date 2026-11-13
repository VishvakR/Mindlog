#!/usr/bin/env bash
# Phase 10 gate (PLAN 24). Live: two tenants with quotas on one node, where the limited one is
# refused and the other is not. Then the gate suites: authorization matrix and quotas, TLS and
# mutual TLS with rotation and the production profile, encryption at rest, the tenant lifecycle,
# audit, cross-tenant fuzzing, semantic split, and the TypeScript and Python embedded replicas
# reading through a cut network and replaying their queued writes.
# Removes its data directory afterwards. Exits non-zero if any check fails.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8096}
RESP=${RESP:-6396}
DATA=$(mktemp -d)
LOG="$DATA/node.log"
ADMIN_EMAIL=demo-admin@example.com
ADMIN_PASSWORD='phase ten demo password'
NODE_PID=
cleanup() {
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null && wait "$NODE_PID" 2>/dev/null || true
  rm -rf "$DATA"
}
trap cleanup EXIT
fail() {
  echo "phase10-demo: $*" >&2
  exit 1
}

pnpm build >/dev/null
BIN=packages/server/dist/bin.js
node "$BIN" superuser upsert "$ADMIN_EMAIL" "$ADMIN_PASSWORD" --data-dir "$DATA/db" >/dev/null
MINDLOG_LISTEN__MCP__HTTP__PORT=0 node "$BIN" --single-node --port "$RESP" --http-port "$PORT" \
  --data-dir "$DATA/db" >"$LOG" 2>&1 &
NODE_PID=$!
for _ in $(seq 1 100); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/ready" || true)" = 200 ] && break
  sleep 0.2
done

BASE="http://127.0.0.1:$PORT"
field() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0))[process.argv[1]] ?? ""))' "$1"; }
api() { curl -s -X "$1" "$BASE$2" -H "authorization: Bearer $3" -H 'content-type: application/json' -d "$4"; }
ROOT=$(curl -s -X POST "$BASE/api/superusers/auth-with-password" -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | field token)
[ -n "$ROOT" ] || fail "could not sign in"
api POST /api/tenants "$ROOT" '{"name":"acme","quotas":{"writeQps":5}}' >/dev/null
api POST /api/tenants "$ROOT" '{"name":"globex"}' >/dev/null
ACME=$(api POST /api/tenants/acme/keys "$ROOT" '{"name":"app","role":"developer"}' | field key)
GLOBEX=$(api POST /api/tenants/globex/keys "$ROOT" '{"name":"app","role":"developer"}' | field key)
[ -n "$ACME" ] && [ -n "$GLOBEX" ] || fail "could not create the tenants' keys"

# 30 writes as fast as curl goes: acme's 5 writes/s is exceeded, globex has no quota.
burst() {
  local ok=0 limited=0 code
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/kv/keys/k$i" \
      -H "authorization: Bearer $1" -H 'content-type: application/json' \
      -d '{"type":"string","value":"v"}')
    case $code in
      200 | 204) ok=$((ok + 1)) ;;
      429) limited=$((limited + 1)) ;;
      *) fail "write answered $code" ;;
    esac
  done
  echo "$ok $limited"
}
read -r ACME_OK ACME_LIMITED < <(burst "$ACME")
read -r GLOBEX_OK GLOBEX_LIMITED < <(burst "$GLOBEX")
echo "acme (5 writes/s): $ACME_OK accepted, $ACME_LIMITED rate-limited"
echo "globex (no quota): $GLOBEX_OK accepted, $GLOBEX_LIMITED rate-limited"
[ "$ACME_LIMITED" -gt 0 ] || fail "acme was never limited"
[ "$GLOBEX_LIMITED" -eq 0 ] || fail "globex was limited by acme's quota"
kill "$NODE_PID" && wait "$NODE_PID" 2>/dev/null || true
NODE_PID=

pnpm vitest run \
  test/integration/access-control.test.ts \
  test/integration/tls.test.ts \
  test/integration/encryption.test.ts \
  test/integration/tenant-lifecycle.test.ts \
  test/integration/audit.test.ts \
  test/integration/tenant-fuzz.test.ts \
  test/integration/semantic-split.test.ts \
  test/integration/sdk-replica.test.ts
(cd python && uv run pytest sdk/tests -m integration -q)
echo "phase10-demo: all checks passed"
