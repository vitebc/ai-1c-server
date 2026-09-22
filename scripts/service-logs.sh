#!/bin/bash
# Follow/stream service logs (journald).
#   ./scripts/service-logs.sh [-n 200]   # last N lines, no follow
#   ./scripts/service-logs.sh            # follow
SERVICE=ai-1c-server

if [ "$1" = "-n" ] && [ -n "$2" ]; then
  journalctl -u "$SERVICE" -n "$2" --no-pager
else
  journalctl -u "$SERVICE" -f -n 100
fi
