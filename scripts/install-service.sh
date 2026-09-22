#!/bin/bash
# Install ai-1c-server as a systemd service (autostart on boot).
#
#   sudo ./scripts/install-service.sh [--user NAME] [--port 9224] [--data-dir PATH]
#
# Defaults: --user = invoking sudo user (or current user), --port 9224,
# --data-dir <repo>/data. Requires a built binary (./scripts/build-linux.sh).
# Overrides for testing: UNIT_DIR, ENV_DIR env vars.
set -e

SERVICE=ai-1c-server
DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
ENV_DIR="${ENV_DIR:-/etc/ai-1c-server}"

USER_NAME=""
PORT="9224"
DATA_DIR="$DIR/data"
while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    *) echo "Unknown arg: $1 (see --user/--port/--data-dir)"; exit 1 ;;
  esac
done

if [ -z "$USER_NAME" ]; then
  USER_NAME="${SUDO_USER:-$(whoami)}"
fi
BINARY="$DIR/target/x86_64-unknown-linux-gnu/release/ai-1c-server"

if [ ! -x "$BINARY" ]; then
  echo "ERROR: binary not found: $BINARY"
  echo "Build it first: ./scripts/build-linux.sh"
  exit 1
fi
if [ ! -d "$DIR/admin-ui/dist" ]; then
  echo "WARNING: admin-ui/dist missing — web UI will not be served (API still works)"
fi
if [ "$UNIT_DIR" = "/etc/systemd/system" ] && [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (sudo) to install into /etc/systemd/system"
  exit 1
fi
if ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "ERROR: user '$USER_NAME' does not exist"
  exit 1
fi
mkdir -p "$DATA_DIR"
chown "$USER_NAME" "$DATA_DIR" 2>/dev/null || true

# Refuse to shadow a live manual instance on the same port.
if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/health" 2>/dev/null)" = "200" ]; then
  echo "ERROR: port $PORT already answers /health — stop the manual instance first:"
  echo "  ./scripts/stop.sh   (or PORT=$PORT ./scripts/stop.sh)"
  exit 1
fi

mkdir -p "$UNIT_DIR" "$ENV_DIR"
sed -e "s|@USER@|$USER_NAME|g" \
    -e "s|@DIR@|$DIR|g" \
    -e "s|@DATA_DIR@|$DATA_DIR|g" \
    -e "s|@PORT@|$PORT|g" \
    -e "s|@BINARY@|$BINARY|g" \
    "$DIR/scripts/systemd/ai-1c-server.service" > "$UNIT_DIR/$SERVICE.service"
chmod 644 "$UNIT_DIR/$SERVICE.service"

# Env overrides (PORT / DATA_DIR). Missing file = compiled defaults.
cat > "$ENV_DIR/env" <<EOF
# ai-1c-server service overrides. Restart the service after editing:
#   sudo systemctl restart $SERVICE
PORT=$PORT
DATA_DIR=$DATA_DIR
EOF
chmod 600 "$ENV_DIR/env"

if [ "$UNIT_DIR" = "/etc/systemd/system" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable --now "$SERVICE"
  sleep 2
  systemctl --no-pager status "$SERVICE" | head -12
  echo "--- health ---"
  curl -s "http://localhost:$PORT/health" && echo ""
else
  echo "systemd not running here — unit written to $UNIT_DIR/$SERVICE.service, enable on the target host:"
  echo "  sudo systemctl daemon-reload && sudo systemctl enable --now $SERVICE"
fi
echo "Logs: ./scripts/service-logs.sh  |  Status: ./scripts/service-status.sh"
