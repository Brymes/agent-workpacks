#!/bin/sh
# Compatibility entry point for older LaunchAgents. The watcher owns locking, sweeping, queueing and notifications.
set -u
PACK="${1:?pack dir required}"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${DP_NODE_BIN:-node}"
exec "$NODE_BIN" "$SKILL/scripts/pack-watch.mjs" tick --pack "$PACK"
