#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$DIR/data}"
PORT="${PORT:-9224}"
BINARY="$DIR/target/x86_64-unknown-linux-gnu/release/ai-1c-server"

mkdir -p "$DATA_DIR"

"$BINARY" --data-dir "$DATA_DIR" --http-port "$PORT" --admin-dir "$DIR/admin-ui/dist" migrate

nohup "$BINARY" \
  --data-dir "$DATA_DIR" \
  --http-port "$PORT" \
  --admin-dir "$DIR/admin-ui/dist" \
  > "$DIR/server.log" 2>&1 &

PID=$!
echo "$PID" > "$DIR/server.pid"
echo "ai-1c-server started (PID: $PID)"
