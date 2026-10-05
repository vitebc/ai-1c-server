#!/bin/bash
# Запустить dev-демон ai-1c-server (порт 9225, data/)
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$DIR/data"
PORT=9225
BINARY="$DIR/target/x86_64-unknown-linux-gnu/release/ai-1c-server"
LOG="$DIR/server-dev.log"
PID_FILE="$DIR/server-dev.pid"

if [ ! -x "$BINARY" ]; then
  echo "ERROR: binary not found: $BINARY"
  echo "Build it first: ./scripts/build-linux.sh"
  exit 1
fi

mkdir -p "$DATA_DIR"

# Pre-flight: refuse to shadow a live instance
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "ERROR: dev already running (PID: $(cat "$PID_FILE")). Stop it first: ./scripts/stop-dev.sh"
  exit 1
fi
if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/health" 2>/dev/null)" = "200" ]; then
  echo "ERROR: port $PORT already answers /health (another instance?)."
  exit 1
fi

"$BINARY" --data-dir "$DATA_DIR" --http-port "$PORT" --admin-dir "$DIR/admin-ui/dist" migrate

exec "$BINARY" \
  --data-dir "$DATA_DIR" \
  --http-port "$PORT" \
  --admin-dir "$DIR/admin-ui/dist" \
  > "$LOG" 2>&1 &

PID=$!
echo "$PID" > "$PID_FILE"

for _ in $(seq 1 30); do
  if kill -0 "$PID" 2>/dev/null; then
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/health" 2>/dev/null)" = "200" ]; then
      sleep 1
      if kill -0 "$PID" 2>/dev/null; then
        echo "ai-1c-server DEV started (PID: $PID) — http://localhost:$PORT/health OK"
        echo ""
        echo "Dev admin:  http://localhost:$PORT"
        echo "Dev backend: http://localhost:8001"
        echo "Prod admin:  http://localhost:9224 (не тронут)"
        exit 0
      fi
    fi
  else
    echo "ERROR: process died immediately. Last log lines from $LOG:"
    tail -25 "$LOG"
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 0.5
done

echo "ERROR: no /health after 15s (PID: $PID). Last log lines from $LOG:"
tail -25 "$LOG"
exit 1
