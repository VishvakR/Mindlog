#!/usr/bin/env bash
# Usage: scripts/gen-proto.sh
# Regenerates code from proto/ (ADR-0004). Generated code is committed; CI runs
# this and fails if the working tree changes.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm exec buf lint
pnpm exec buf generate
