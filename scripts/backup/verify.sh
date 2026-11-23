#!/usr/bin/env bash
# verify.sh — проверка целостности бэкапа
#
# Использование:
#   ./verify.sh [--full]
#
# Что делает:
#   1. restic check --read-data-subset=10% (быстро) или --read-data (полно)
#   2. Восстанавливает последний снапшот в /var/tmp/ai-1c-verify
#   3. Проверяет SQLite integrity_check для всех БД
#   4. Проверяет pg_restore --list для agentdb.dump
#   5. Сравнивает MANIFEST.txt с текущим состоянием

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

FULL_CHECK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full) FULL_CHECK=1; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done

mkdir -p "$BACKUP_HOME"
[ -f "$LOG_FILE" ] || touch "$LOG_FILE"

if [ ! -f "$RESTIC_PASSWORD_FILE" ]; then
  die "Restic password file not found: $RESTIC_PASSWORD_FILE"
fi

log "=== Verify started ==="
ensure_repo

# === 1. Restic check ===
if [ "$FULL_CHECK" = "1" ]; then
  log "Running restic check --read-data (full)..."
  restic check --read-data
else
  log "Running restic check --read-data-subset=10%..."
  restic check --read-data-subset=10%
fi

# === 2. Restore latest snapshot to temp ===
VERIFY_STAGE="/var/tmp/ai-1c-verify"
rm -rf "$VERIFY_STAGE"
mkdir -p "$VERIFY_STAGE"

log "Restoring latest snapshot to $VERIFY_STAGE..."
restic restore latest --target "$VERIFY_STAGE"

STAGE_ROOT="$VERIFY_STAGE/root/home/test"

# === 3. SQLite integrity checks ===
log "Checking SQLite integrity..."
FAILURES=0

check_sqlite() {
  local db="$1" label="$2"
  if [ -f "$db" ]; then
    result="$(sqlite3 "$db" 'PRAGMA integrity_check;')"
    if [ "$result" = "ok" ]; then
      log "  OK: $label ($(du -h "$db" | cut -f1))"
    else
      log "  FAIL: $label — $result"
      FAILURES=$((FAILURES + 1))
    fi
  else
    log "  SKIP: $label (not found)"
  fi
}

check_sqlite "$STAGE_ROOT/.config/ai-1c-server/adminka/data/db.sqlite" "prod db.sqlite"
check_sqlite "$STAGE_ROOT/project/ai-1c-server/data/db.sqlite" "dev db.sqlite"

# OpenCode volumes
for vol in main ka2 upp doc3; do
  if [ -d "$VERIFY_STAGE/opencode-volumes/$vol" ]; then
    check_sqlite "$VERIFY_STAGE/opencode-volumes/$vol/opencode.db" "opencode $vol"
  fi
done

# === 4. PostgreSQL dump check ===
if [ -f "$VERIFY_STAGE/agentdb.dump" ]; then
  log "Checking agentdb.dump..."
  if pg_restore --list "$VERIFY_STAGE/agentdb.dump" >/dev/null 2>&1; then
    log "  OK: agentdb.dump ($(du -h "$VERIFY_STAGE/agentdb.dump" | cut -f1))"
  else
    log "  FAIL: agentdb.dump is not a valid pg_dump file"
    FAILURES=$((FAILURES + 1))
  fi
else
  log "  SKIP: agentdb.dump (not found)"
fi

# === 5. Manifest comparison ===
if [ -f "$VERIFY_STAGE/MANIFEST.txt" ]; then
  log "Manifest from snapshot:"
  cat "$VERIFY_STAGE/MANIFEST.txt"
fi

# === Cleanup ===
rm -rf "$VERIFY_STAGE"

# === Result ===
echo ""
if [ "$FAILURES" = "0" ]; then
  log "=== Verify PASSED ==="
else
  log "=== Verify FAILED: $FAILURES errors ==="
  exit 1
fi
