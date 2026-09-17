#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

git pull
./scripts/build-linux.sh
./scripts/restart.sh

echo "Update complete"
