#!/usr/bin/env bash
# Dev launcher for reaper with auto-respawn on crash.
#
# Usage:
#   ./dev.sh                # run in foreground (ctrl-c to stop)
#   ./dev.sh --bg           # run in background, logs → reaper.log, PID → .pid
#   ./dev.sh stop           # kill the backgrounded process
#   ./dev.sh status         # check status
#
# Why: `bun --watch` dies on startup errors instead of waiting for the next
# file save. This wrapper respawns it. Respawn rate is rate-limited to avoid
# thrashing if a persistent error is introduced.

set -u

cd "$(dirname "$0")"

PID_FILE=".pid"
LOG_FILE="reaper.log"
MIN_UPTIME_SEC=5        # treat faster-than-this exits as crashes
MAX_CRASHES=5           # abort if we crash >N times within window
CRASH_WINDOW_SEC=30     # sliding window for crash counting

cmd="${1:-fg}"

stop_existing() {
  if [[ -f "$PID_FILE" ]]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "[dev.sh] Stopping PID $pid..."
      kill -TERM "$pid" 2>/dev/null || true
      # Wait up to 10s for graceful shutdown
      for _ in {1..10}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # Also kill any stray bun --watch processes for this project
  pkill -f "bun --watch src/main.ts" 2>/dev/null || true
}

status() {
  if [[ -f "$PID_FILE" ]]; then
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "[dev.sh] Running (PID $pid)"
      return 0
    fi
  fi
  echo "[dev.sh] Not running"
  return 1
}

run_loop() {
  # Trap signals so we clean up the inner bun process too
  trap 'stop_existing; exit 0' INT TERM

  # Crash-rate limiter
  crash_ts=()

  while true; do
    started=$(date +%s)
    echo "[dev.sh $(date '+%H:%M:%S')] Starting: bun --watch src/main.ts"
    bun --watch src/main.ts
    exit_code=$?
    ended=$(date +%s)
    uptime=$((ended - started))

    if [[ $exit_code -eq 0 ]]; then
      echo "[dev.sh] Clean exit (code 0) — not respawning"
      break
    fi

    echo "[dev.sh $(date '+%H:%M:%S')] bun exited with code $exit_code after ${uptime}s"

    # Count only "fast" exits toward the crash limiter
    if [[ $uptime -lt $MIN_UPTIME_SEC ]]; then
      crash_ts+=("$ended")
      # Trim crashes outside the window
      cutoff=$((ended - CRASH_WINDOW_SEC))
      new_ts=()
      for t in "${crash_ts[@]}"; do
        if [[ $t -gt $cutoff ]]; then new_ts+=("$t"); fi
      done
      crash_ts=("${new_ts[@]}")

      if [[ ${#crash_ts[@]} -ge $MAX_CRASHES ]]; then
        echo "[dev.sh] ${#crash_ts[@]} fast crashes within ${CRASH_WINDOW_SEC}s — aborting. Check $LOG_FILE."
        exit 1
      fi
    else
      # Healthy uptime — reset the counter
      crash_ts=()
    fi

    sleep 2
  done
}

case "$cmd" in
  stop)
    stop_existing
    ;;
  status)
    status
    ;;
  --bg|bg)
    stop_existing
    echo "[dev.sh] Starting in background, logs → $LOG_FILE"
    nohup bash "$0" fg >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    status
    ;;
  fg|*)
    run_loop
    ;;
esac
