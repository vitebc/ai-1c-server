#!/bin/bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$DIR/server.pid"
PORT="${PORT:-9224}"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "ai-1c-server is running (PID: $PID)"
    curl -s http://localhost:$PORT/health && echo ""
  else
    echo "PID file exists but process is dead"
    rm -f "$PID_FILE"
  fi
else
  echo "ai-1c-server is not running"
fi
