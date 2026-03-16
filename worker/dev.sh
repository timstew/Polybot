#!/usr/bin/env bash
# Start wrangler dev with persistent state, fixed port, and crash logging.
# Usage: cd worker && ./dev.sh
#
# IMPORTANT: Do NOT use `npm exec wrangler dev ...` — npm exec swallows
# flags like --persist-to and --port as npm config, causing wrangler to
# bind to a random port and lose DO state. Always use npx.
#
# Logs are written to:
#   1. worker/wrangler-dev.log  (stdout+stderr via tee)
#   2. ~/Library/Preferences/.wrangler/logs/  (wrangler's internal logs)

set -euo pipefail
cd "$(dirname "$0")"

# Kill any existing wrangler dev processes to prevent accumulation.
# Multiple stale instances cause OOM when the laptop wakes from sleep
# (all DOs fire alarms simultaneously).
existing=$(pgrep -f "wrangler.*dev" 2>/dev/null || true)
if [ -n "$existing" ]; then
  echo "Killing existing wrangler processes: $existing"
  pkill -f "wrangler.*dev" 2>/dev/null || true
  sleep 1
fi

# Increase Node heap limit — wrangler + multiple DOs with large state
# can exceed the default 4GB during GC pressure (e.g. after laptop wake).
export NODE_OPTIONS="--max-old-space-size=8192"

while true; do
  echo "[dev.sh] Starting wrangler dev at $(date)"
  npx wrangler dev \
    --persist-to .wrangler/state \
    --port 8787 \
    --log-level info \
    --var PYTHON_API_URL:http://127.0.0.1:8000 \
    2>&1 | tee wrangler-dev.log
  echo "[dev.sh] Wrangler exited ($?), restarting in 2s..."
  sleep 2
done
