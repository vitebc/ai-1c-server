#!/bin/bash
# Service status: systemd state + /health + listening port.
#   ./scripts/service-status.sh [PORT]
SERVICE=ai-1c-server
PORT="${1:-${PORT:-9224}}"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl --no-pager --lines 3 status "$SERVICE" || true
  echo "---"
else
  echo "(systemd not running here)"
fi
echo -n "health http://localhost:$PORT/health -> "
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:$PORT/health" 2>/dev/null || echo "unreachable"
