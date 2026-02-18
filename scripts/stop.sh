#!/usr/bin/env bash

PIDFILE="/tmp/polybot-api.pid"

# Stop Python API
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "[polybot] Stopping Python API (PID $PID)..."
    kill "$PID"
    rm -f "$PIDFILE"
    echo "[polybot] Python API stopped"
  else
    echo "[polybot] Python API not running (stale PID file)"
    rm -f "$PIDFILE"
  fi
else
  echo "[polybot] Python API not running"
fi

# Stop any Next.js dev server on :3000
NEXT_PID=$(lsof -ti :3000 2>/dev/null || true)
if [ -n "$NEXT_PID" ]; then
  echo "[polybot] Stopping Next.js (PID $NEXT_PID)..."
  kill $NEXT_PID 2>/dev/null || true
  echo "[polybot] Next.js stopped"
else
  echo "[polybot] Next.js not running"
fi
