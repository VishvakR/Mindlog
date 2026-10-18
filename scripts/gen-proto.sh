#!/usr/bin/env bash
# Usage: scripts/gen-proto.sh
# Regenerates code from proto/ (ADR-0004): TypeScript via buf + protoc-gen-es,
# Python via grpcio-tools in the uv workspace. Generated code is committed; CI
# runs this and fails if the working tree changes.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm exec buf lint
pnpm exec buf generate

PY_OUT=python/mindlog_proto/src
find "$PY_OUT/mindlog/v1" \( -name '*_pb2.py*' -o -name '*_pb2_grpc.py' \) -delete
(cd python && uv run --frozen python -m grpc_tools.protoc \
  -I ../proto --python_out="../$PY_OUT" --pyi_out="../$PY_OUT" \
  $(cd ../proto && find mindlog -name '*.proto' | sort | sed 's#^#../proto/#'))
# Only the model service is served from Python, so only it gets gRPC stubs.
(cd python && uv run --frozen python -m grpc_tools.protoc \
  -I ../proto --grpc_python_out="../$PY_OUT" ../proto/mindlog/v1/models.proto)
