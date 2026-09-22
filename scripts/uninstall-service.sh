#!/bin/bash
# Remove the ai-1c-server systemd service (data dir is kept).
#   sudo ./scripts/uninstall-service.sh
set -e

SERVICE=ai-1c-server
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
ENV_DIR="${ENV_DIR:-/etc/ai-1c-server}"

if [ "$UNIT_DIR" = "/etc/systemd/system" ] && [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root (sudo)"
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
fi
rm -f "$UNIT_DIR/$SERVICE.service"
rm -rf "$ENV_DIR"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl daemon-reload
fi
echo "Service $SERVICE removed (project data untouched)."
