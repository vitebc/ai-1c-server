#!/bin/bash
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$DIR/server.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  kill "$PID" 2>/dev/null && echo "Stopped PID $PID" || echo "Process $PID not found"
  rm -f "$PID_FILE"
else
  echo "No PID file found"
fi
