#!/usr/bin/env bash
# Usage: scripts/clone-references.sh <phase|all>
# Shallow-clones the reference repos for a phase (PLAN.md 28.9) into
# $MINDLOG_REFS_DIR (default: ./references, gitignored). Read-only material:
# never copy code from these repos into packages/ (see PLAN.md 28.1).
set -euo pipefail

cd "$(dirname "$0")/.."
REFS_DIR="${MINDLOG_REFS_DIR:-references}"
mkdir -p "$REFS_DIR"
cd "$REFS_DIR"

# exists <dir> [alias...]: true if the repo is already present under any name
exists() {
  local d
  for d in "$@"; do [ -d "$d" ] && return 0; done
  return 1
}

# clone <dir> <url> [alias...]
clone() {
  local dir="$1" url="$2"
  shift 2
  if exists "$dir" "$@"; then echo "skip  $dir (present)"; return; fi
  git clone --depth 1 "$url" "$dir"
}

# sparse <dir> <url> <path>...: for very large repos, check out only <path>s
sparse() {
  local dir="$1" url="$2"
  shift 2
  if exists "$dir"; then echo "skip  $dir (present)"; return; fi
  git clone --depth 1 --filter=blob:none --sparse "$url" "$dir"
  git -C "$dir" sparse-checkout set "$@"
}

PHASE="${1:-all}"

# want <phase>...: true if PHASE is "all" or one of the given phases
want() {
  local p
  [ "$PHASE" = all ] && return 0
  for p in "$@"; do [ "$PHASE" = "$p" ] && return 0; done
  return 1
}

if want 0; then
  sparse foundationdb https://github.com/apple/foundationdb design bindings/python/fdb
  sparse cockroach https://github.com/cockroachdb/cockroach pkg/util/encoding docs
fi
if want 1; then
  clone redis-specifications https://github.com/redis/redis-specifications
  sparse valkey https://github.com/valkey-io/valkey src tests
  sparse redis https://github.com/redis/redis src/commands tests/unit
  clone node-redis https://github.com/redis/node-redis
  clone classic-level https://github.com/Level/classic-level
fi
if want 2 9; then
  clone pocketbase https://github.com/pocketbase/pocketbase
  clone pocketbase-js-sdk https://github.com/pocketbase/js-sdk
fi
if want 3; then
  clone etcd-raft https://github.com/etcd-io/raft raft
  clone hashicorp-raft https://github.com/hashicorp/raft
  clone maelstrom https://github.com/jepsen-io/maelstrom
  clone dissertation https://github.com/ongardie/dissertation
fi
if want 4 10; then
  sparse tikv https://github.com/tikv/tikv components src docs
  clone pd https://github.com/tikv/pd
fi
if want 5; then
  clone mem0 https://github.com/mem0ai/mem0
  clone cognee https://github.com/topoteretes/cognee
  clone letta-code https://github.com/letta-ai/letta-code
  clone mcp-typescript-sdk https://github.com/modelcontextprotocol/typescript-sdk
  clone agent-memory-server https://github.com/redis-developer/agent-memory-server
  clone GLiNER https://github.com/urchade/GLiNER
  clone hnswlib-node https://github.com/yoshoku/hnswlib-node
fi
if want 6; then
  clone HippoRAG https://github.com/OSU-NLP-Group/HippoRAG
  clone LightRAG https://github.com/HKUDS/LightRAG
  clone GPTCache https://github.com/zilliztech/GPTCache
  clone memory-benchmarks https://github.com/mem0ai/memory-benchmarks
  clone LongMemEval https://github.com/xiaowu0162/LongMemEval
  clone locomo https://github.com/snap-research/locomo
fi
if want 7; then
  clone graphiti https://github.com/getzep/graphiti
  clone automerge https://github.com/automerge/automerge
fi
if want 8; then
  clone A-mem https://github.com/agiresearch/A-mem
  clone MemOS https://github.com/MemTensor/MemOS
  clone graphrag https://github.com/microsoft/graphrag
  clone MemoryBank https://github.com/zhongwanjun/MemoryBank-SiliconFriend
fi
echo "References ready in $(pwd)."
