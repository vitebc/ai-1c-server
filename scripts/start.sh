#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$DIR/data}"
PORT="${PORT:-9224}"
BINARY="$DIR/target/x86_64-unknown-linux-gnu/release/ai-1c-server"
LOG="$DIR/server.log"
PID_FILE="$DIR/server.pid"

if [ ! -x "$BINARY" ]; then
  echo "ERROR: binary not found: $BINARY"
  echo "Build it first: ./scripts/build-linux.sh"
  exit 1
fi

if [ ! -d "$DIR/admin-ui/dist" ]; then
  echo "WARNING: admin-ui/dist missing — web UI will not be served (API still works)"
  echo "Build it: cd admin-ui && npm install && npm run build"
fi

mkdir -p "$DATA_DIR"

# Pre-flight: refuse to shadow a live instance (health could come from it).
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "ERROR: already running (PID: $(cat "$PID_FILE")). Stop it first: ./scripts/stop.sh"
  exit 1
fi
if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/health" 2>/dev/null)" = "200" ]; then
  echo "ERROR: port $PORT already answers /health (another instance?)."
  echo "Stop it first or use another port: PORT=9225 ./scripts/start.sh"
  exit 1
fi

"$BINARY" --data-dir "$DATA_DIR" --http-port "$PORT" --admin-dir "$DIR/admin-ui/dist" migrate

nohup "$BINARY" \
  --data-dir "$DATA_DIR" \
  --http-port "$PORT" \
  --admin-dir "$DIR/admin-ui/dist" \
  > "$LOG" 2>&1 &

PID=$!
echo "$PID" > "$PID_FILE"

# Wait for health (up to ~15s); fail loudly with log tail otherwise.
for _ in $(seq 1 30); do
  if kill -0 "$PID" 2>/dev/null; then
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/health" 2>/dev/null)" = "200" ]; then
      # Health may answer while our process is still dying — re-verify.
      sleep 1
      if kill -0 "$PID" 2>/dev/null; then
        echo "ai-1c-server started (PID: $PID) — http://localhost:$PORT/health OK"
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
