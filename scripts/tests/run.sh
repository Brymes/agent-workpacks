#!/bin/bash
# bash-3.2-safe wrapper: run the agent-workpacks fixture tests with the pinned Node (or $DP_NODE_BIN).
NODE_BIN="${DP_NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || NODE_BIN="$(command -v node)"
exec "$NODE_BIN" "$(cd "$(dirname "$0")" && pwd)/run.mjs" "$@"
