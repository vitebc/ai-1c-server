#!/bin/bash
# Выкатка prod: сборка (admin-ui + бинарник) → копирование в adminka/ → рестарт.
# Prod живёт в $ADM_DIR: только то, что нужно для запуска (бинарник, dist, migrations, data).
# Dev (master, порт 9225) не затрагивается.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ADM_DIR="${ADM_DIR:-/home/test/.config/ai-1c-server/adminka}"
BINARY="$DIR/target/x86_64-unknown-linux-gnu/release/ai-1c-server"

if [ ! -d "$ADM_DIR" ]; then
  echo "ERROR: prod dir not found: $ADM_DIR (override with ADM_DIR=...)"
  exit 1
fi

echo "=== Building admin-ui ==="
cd "$DIR/admin-ui"
npm install
BUILD_OUT=$(npm run build 2>&1)
echo "$BUILD_OUT"
if echo "$BUILD_OUT" | grep -q "error TS"; then
  echo "ERROR: tsc reported errors — NOT deploying (broken bundle would go to prod)."
  exit 1
fi
cd "$DIR"

echo "=== Building server (Linux) ==="
cargo build --release --target x86_64-unknown-linux-gnu

# Сначала stop: бинарник занят запущенным процессом (cp → "Text file busy").
echo "=== Stopping prod ==="
"$ADM_DIR/stop.sh"

echo "=== Copying artifacts to $ADM_DIR ==="
cp "$BINARY" "$ADM_DIR/ai-1c-server"
rm -rf "$ADM_DIR/admin-ui/dist"
cp -r "$DIR/admin-ui/dist" "$ADM_DIR/admin-ui/dist"
cp "$DIR"/migrations/*.sql "$ADM_DIR/migrations/"

echo "=== Starting prod ==="
"$ADM_DIR/start.sh"

BUNDLE=$(curl -s http://localhost:9224/ | grep -o 'index-[^"]*\.js' | head -1 || true)
echo ""
echo "Deploy complete. Prod bundle: ${BUNDLE:-<not detected>}"
