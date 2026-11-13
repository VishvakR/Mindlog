#!/usr/bin/env bash
# CycloneDX SBOMs of the release (PLAN 18.6): the Node workspace from pnpm-lock.yaml (cdxgen,
# pinned, run through pnpm dlx: pnpm 10 has no exporter) and the Python workspace from uv.lock.
# Usage: scripts/sbom.sh [out-dir]   (default dist/sbom)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-dist/sbom}
mkdir -p "$OUT"
CDXGEN_NO_BANNER=true FETCH_LICENSE=false pnpm dlx @cyclonedx/cdxgen@12.9.0 -t js --spec-version 1.5 \
  --no-install-deps -o "$OUT/mindlog-node.cdx.json" . >/dev/null
(cd python && uv export --frozen --all-packages --format cyclonedx1.5 --preview-features sbom-export) >"$OUT/mindlog-python.cdx.json"
echo "sbom: wrote $OUT/mindlog-node.cdx.json and $OUT/mindlog-python.cdx.json"
