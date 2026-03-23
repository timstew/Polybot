#!/usr/bin/env bash
# Polybot local dev: starts and watches all three servers.
# Survives macOS sleep/wake by health-checking each service and restarting as needed.
#
# Usage: cd worker && ./dev.sh          # foreground (Ctrl-C stops all)
#        cd worker && ./dev.sh &        # background
#
# Services:
#   Worker   (wrangler dev)  → localhost:8787
#   Python   (uvicorn)       → localhost:8000
#   Web      (next dev)      → localhost:3000
#
# Logs: worker/wrangler-dev.log, worker/python-api.log, worker/next-dev.log

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PIDFILE="$SCRIPT_DIR/.dev.pid"

# Kill any previous dev.sh instance and its services
if [ -f "$PIDFILE" ]; then
  old_pid=$(cat "$PIDFILE")
  if kill -0 "$old_pid" 2>/dev/null; then
    echo "[dev.sh] Stopping previous instance (PID $old_pid)..."
    kill "$old_pid" 2>/dev/null || true
    # Wait for it to clean up
    for i in 1 2 3 4 5; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$old_pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi
echo $$ > "$PIDFILE"

WORKER_PORT=8787
PYTHON_PORT=8000
WEB_PORT=3000
HEALTH_INTERVAL=10       # seconds between health checks
FAIL_THRESHOLD=3         # consecutive failures before restart

WRANGLER_PID=""
PYTHON_PID=""
WEB_PID=""

worker_fail_count=0
python_fail_count=0
web_fail_count=0

cleanup() {
  echo "[dev.sh] Shutting down all services..."
  [ -n "$WRANGLER_PID" ] && kill "$WRANGLER_PID" 2>/dev/null
  [ -n "$PYTHON_PID" ]   && kill "$PYTHON_PID" 2>/dev/null
  [ -n "$WEB_PID" ]      && kill "$WEB_PID" 2>/dev/null
  pkill -f "wrangler.*dev" 2>/dev/null || true
  rm -f "$PIDFILE"
  exit 0
}
trap cleanup INT TERM

# ── Service management ─────────────────────────────────────────────

kill_on_port() {
  local port=$1
  local pids
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "[dev.sh] Killing processes on port $port: $pids"
    echo "$pids" | xargs kill 2>/dev/null || true
    # Wait up to 5s for port to be freed
    for i in 1 2 3 4 5; do
      lsof -ti :"$port" > /dev/null 2>&1 || break
      sleep 1
    done
    # Force-kill if still bound
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      echo "[dev.sh] Force-killing lingering processes on port $port: $pids"
      echo "$pids" | xargs kill -9 2>/dev/null || true
      sleep 1
    fi
  fi
}

start_worker() {
  kill_on_port $WORKER_PORT
  pkill -f "wrangler.*dev" 2>/dev/null || true
  sleep 1
  echo "[dev.sh] Starting worker (wrangler dev) at $(date)"
  export NODE_OPTIONS="--max-old-space-size=8192"
  cd "$SCRIPT_DIR"
  npx wrangler dev \
    --persist-to .wrangler/state \
    --port $WORKER_PORT \
    --log-level info \
    --var PYTHON_API_URL:http://127.0.0.1:$PYTHON_PORT \
    >> "$SCRIPT_DIR/wrangler-dev.log" 2>&1 &
  WRANGLER_PID=$!
  worker_fail_count=0
  echo "[dev.sh] Worker started (PID $WRANGLER_PID)"
}

start_python() {
  kill_on_port $PYTHON_PORT
  echo "[dev.sh] Starting Python API (uvicorn) at $(date)"
  cd "$PROJECT_ROOT"
  python3 -m uvicorn polybot.api:app --host 127.0.0.1 --port $PYTHON_PORT \
    >> "$SCRIPT_DIR/python-api.log" 2>&1 &
  PYTHON_PID=$!
  python_fail_count=0
  echo "[dev.sh] Python API started (PID $PYTHON_PID)"
}

start_web() {
  kill_on_port $WEB_PORT
  echo "[dev.sh] Starting web (next dev) at $(date)"
  cd "$PROJECT_ROOT/web"
  npx next dev --port $WEB_PORT \
    >> "$SCRIPT_DIR/next-dev.log" 2>&1 &
  WEB_PID=$!
  web_fail_count=0
  echo "[dev.sh] Web started (PID $WEB_PID)"
}

check_health() {
  local port=$1
  curl -sf --max-time 3 "http://127.0.0.1:$port/" > /dev/null 2>&1
}

check_worker_health() {
  curl -sf --max-time 3 "http://127.0.0.1:$WORKER_PORT/api/strategy/configs" > /dev/null 2>&1
}

check_python_health() {
  # Python API has no root route; use wallet-overview which proxies through it
  curl -sf --max-time 5 "http://127.0.0.1:$PYTHON_PORT/api/strategy/wallet-overview" > /dev/null 2>&1
}

# ── Initial startup ────────────────────────────────────────────────

echo "[dev.sh] ═══════════════════════════════════════════════════"
echo "[dev.sh] Polybot local dev — (re)starting all services"
echo "[dev.sh] ═══════════════════════════════════════════════════"

# Always kill and restart all services to pick up code changes
start_worker
sleep 3

start_python
sleep 2

start_web
sleep 2

echo "[dev.sh] All services started. Health checks every ${HEALTH_INTERVAL}s."

# ── Watchdog loop ──────────────────────────────────────────────────

while true; do
  sleep "$HEALTH_INTERVAL"

  # Worker health
  if check_worker_health; then
    worker_fail_count=0
  else
    worker_fail_count=$((worker_fail_count + 1))
    echo "[dev.sh] Worker health check failed ($worker_fail_count/$FAIL_THRESHOLD)"
    if [ "$worker_fail_count" -ge "$FAIL_THRESHOLD" ]; then
      echo "[dev.sh] Worker unresponsive, restarting..."
      start_worker
      sleep 3
    fi
  fi

  # Python API health
  if check_python_health; then
    python_fail_count=0
  else
    python_fail_count=$((python_fail_count + 1))
    echo "[dev.sh] Python API health check failed ($python_fail_count/$FAIL_THRESHOLD)"
    if [ "$python_fail_count" -ge "$FAIL_THRESHOLD" ]; then
      echo "[dev.sh] Python API unresponsive, restarting..."
      start_python
      sleep 2
    fi
  fi

  # Web health
  if check_health $WEB_PORT; then
    web_fail_count=0
  else
    web_fail_count=$((web_fail_count + 1))
    echo "[dev.sh] Web health check failed ($web_fail_count/$FAIL_THRESHOLD)"
    if [ "$web_fail_count" -ge "$FAIL_THRESHOLD" ]; then
      echo "[dev.sh] Web unresponsive, restarting..."
      start_web
      sleep 2
    fi
  fi
done
