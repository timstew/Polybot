#!/usr/bin/env bash
set -e

PIDFILE="/tmp/polybot-api.pid"

# Start Python API if not already running
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "[polybot] Python API already running (PID $(cat "$PIDFILE"))"
else
  echo "[polybot] Starting Python API on :8000..."
  uvicorn polybot.api:app --host 127.0.0.1 --port 8000 --log-level warning &
  API_PID=$!
  echo "$API_PID" > "$PIDFILE"
  echo "[polybot] Python API started (PID $API_PID)"

  # Wait for API to be ready
  for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:8000/api/stats > /dev/null 2>&1; then
      echo "[polybot] Python API ready"
      break
    fi
    sleep 0.5
  done
fi

# Start Next.js dev server (foreground)
echo "[polybot] Starting Next.js dev server on :3000..."
cd web && exec bun run dev
