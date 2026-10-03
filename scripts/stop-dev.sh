#!/bin/bash
# Остановить dev-демон ai-1c-server (prod не трогается)
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$DIR/server-dev.pid"
PORT=9225

if [ ! -f "$PID_FILE" ]; then
  echo "Dev not running (no PID file)"
  exit 0
fi

PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping dev (PID: $PID)..."
  kill "$PID"
  
  for _ in $(seq 1 10); do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  
  if kill -0 "$PID" 2>/dev/null; then
    echo "Force killing..."
    kill -9 "$PID"
  fi
  
  rm -f "$PID_FILE"
  echo "✓ Dev stopped"
  echo "  Prod remains running on :9224"
else
  echo "Dev not running (stale PID file)"
  rm -f "$PID_FILE"
fi
