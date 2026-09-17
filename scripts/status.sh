#!/bin/bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$DIR/server.pid"
PORT="${PORT:-9224}"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "ai-1c-server is running (PID: $PID)"
    curl -s "http://localhost:$PORT/health" && echo ""
  else
    echo "PID file exists but process $PID is dead"
    rm -f "$PID_FILE"
  fi
else
  echo "No PID file"
fi

if command -v ss >/dev/null 2>&1; then
  LISTENER=$(ss -ltn 2>/dev/null | grep ":$PORT " || true)
  if [ -n "$LISTENER" ]; then
    echo "Port $PORT is LISTENING (maybe another instance?):"
    echo "$LISTENER"
  else
    echo "Port $PORT is free"
  fi
fi
