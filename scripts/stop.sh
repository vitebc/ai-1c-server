#!/bin/bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$DIR/server.pid"
PORT="${PORT:-9224}"

# Find PID of the process listening on $PORT (orphan without PID file).
find_listener_pid() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1
  elif command -v lsof >/dev/null 2>&1; then
    lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
  elif command -v fuser >/dev/null 2>&1; then
    fuser "$PORT"/tcp 2>/dev/null | tr -d ' '
  fi
}

stop_pid() {
  local pid="$1"
  if kill "$pid" 2>/dev/null; then
    echo "Stopped PID $pid"
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || return 0
      sleep 0.5
    done
    echo "PID $pid still alive, killing hard"
    kill -9 "$pid" 2>/dev/null || true
  else
    echo "Process $pid not found"
    return 1
  fi
}

if [ -f "$PID_FILE" ]; then
  stop_pid "$(cat "$PID_FILE")" || true
  rm -f "$PID_FILE"
else
  echo "No PID file found"
fi

# Orphan fallback: something still answers on the port?
ORPHAN=$(find_listener_pid || true)
if [ -n "$ORPHAN" ]; then
  if pgrep -f "ai-1c-server" | grep -qx "$ORPHAN"; then
    echo "Found orphan ai-1c-server (PID: $ORPHAN) listening on $PORT"
    stop_pid "$ORPHAN"
  else
    echo "Port $PORT is held by foreign PID $ORPHAN — not touching it"
  fi
else
  echo "Port $PORT is free"
fi
