#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

git pull
./scripts/build-linux.sh
./scripts/stop.sh
./scripts/start.sh

echo "Update complete"
