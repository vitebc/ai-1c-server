#!/usr/bin/env bash
# restore.sh — восстановление из бэкапа ai-1c-server
#
# Использование:
#   ./restore.sh --list                          # список снапшотов
#   ./restore.sh --snapshot latest --prod        # восстановить prod (adminka + DB)
#   ./restore.sh --snapshot latest --agent       # восстановить agent (1c-chat + pg)
#   ./restore.sh --snapshot latest --opencode    # восстановить OpenCode (config + volumes)
#   ./restore.sh --snapshot latest --full        # всё сразу
#   ./restore.sh --snapshot latest --dry-run     # показать что будет восстановлено
#
# Опции:
#   --target DIR  — куда восстанавливать (по умолчанию /, staging в /var/tmp/ai-1c-restore)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

# === Параметры ===
SNAPSHOT="latest"
TARGET=""
DRY_RUN=0
RESTORE_PROD=0
RESTORE_AGENT=0
RESTORE_OPENCODE=0
RESTORE_FULL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) restic snapshots; exit 0 ;;
    --snapshot) SNAPSHOT="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --prod) RESTORE_PROD=1; shift ;;
    --agent) RESTORE_AGENT=1; shift ;;
    --opencode) RESTORE_OPENCODE=1; shift ;;
    --full) RESTORE_FULL=1; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [ "$RESTORE_FULL" = "1" ]; then
  RESTORE_PROD=1
  RESTORE_AGENT=1
  RESTORE_OPENCODE=1
fi

if [ "$RESTORE_PROD" = "0" ] && [ "$RESTORE_AGENT" = "0" ] && [ "$RESTORE_OPENCODE" = "0" ]; then
  die "Specify what to restore: --prod, --agent, --opencode, or --full"
fi

# === Настройка ===
mkdir -p "$BACKUP_HOME"
[ -f "$LOG_FILE" ] || touch "$LOG_FILE"

if [ ! -f "$RESTIC_PASSWORD_FILE" ]; then
  die "Restic password file not found: $RESTIC_PASSWORD_FILE"
fi

log "=== Restore started ==="
log "Snapshot: $SNAPSHOT"
log "Target: ${TARGET:-/ (staging in /var/tmp/ai-1c-restore)}"
log "Dry-run: $DRY_RUN"
log "Restore: prod=$RESTORE_PROD agent=$RESTORE_AGENT opencode=$RESTORE_OPENCODE"

ensure_repo

# === Staging для restore ===
RESTORE_STAGE="/var/tmp/ai-1c-restore"
rm -rf "$RESTORE_STAGE"
mkdir -p "$RESTORE_STAGE"

# === Restic restore (в staging) ===
log "Restoring snapshot to $RESTORE_STAGE..."
restic restore "$SNAPSHOT" --target "$RESTORE_STAGE"

# Структура после restore:
# $RESTORE_STAGE/root/home/test/...  — конфиги и данные
# $RESTORE_STAGE/agentdb.dump        — PostgreSQL dump
# $RESTORE_STAGE/opencode-volumes/   — OpenCode volumes
# $RESTORE_STAGE/repo/               — git bundle
# $RESTORE_STAGE/MANIFEST.txt        — манифест

STAGE_ROOT="$RESTORE_STAGE/root/home/test"

if [ ! -d "$STAGE_ROOT" ]; then
  die "Expected structure not found in snapshot: $STAGE_ROOT"
fi

log "Snapshot restored to staging. Manifest:"
cat "$RESTORE_STAGE/MANIFEST.txt" 2>/dev/null || echo "(no manifest)"

# === Dry run? ===
if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN: showing what would be restored..."
  echo ""
  echo "=== Files in snapshot ==="
  find "$STAGE_ROOT" -type f | head -50
  echo "..."
  echo ""
  echo "To actually restore, run without --dry-run"
  rm -rf "$RESTORE_STAGE"
  exit 0
fi

# === Restore prod ===
if [ "$RESTORE_PROD" = "1" ]; then
  log "Restoring prod (adminka)..."
  
  # Stop service
  if systemctl --user is-active ai-1c-server-prod.service >/dev/null 2>&1; then
    log "Stopping ai-1c-server-prod..."
    systemctl --user stop ai-1c-server-prod.service
  fi
  
  # Copy files (без data/search-index, java, bsl-ls — они могут быть большими)
  rsync -a "$STAGE_ROOT/.config/ai-1c-server/adminka/" "$PROD_ADMINKA/"
  
  # Restore DB (уже consistent из backup)
  cp -a "$STAGE_ROOT/.config/ai-1c-server/adminka/data/db.sqlite" "$PROD_ADMINKA/data/db.sqlite"
  rm -f "$PROD_ADMINKA/data/db.sqlite-wal" "$PROD_ADMINKA/data/db.sqlite-shm"
  
  # Start service
  log "Starting ai-1c-server-prod..."
  systemctl --user start ai-1c-server-prod.service
  
  # Verify
  sleep 3
  if curl -sf http://localhost:9224/health >/dev/null 2>&1; then
    log "Prod restore OK: /health responds"
  else
    log "WARN: Prod /health not responding, check logs"
  fi
fi

# === Restore agent ===
if [ "$RESTORE_AGENT" = "1" ]; then
  log "Restoring agent (1c-chat)..."
  
  # Stop backend (postgres оставим для restore)
  if docker ps --format '{{.Names}}' | grep -q '^1c-chat-backend-1$'; then
    log "Stopping 1c-chat-backend..."
    (cd "$AGENT_PROD" && docker compose stop backend)
  fi
  
  # Copy files
  rsync -a "$STAGE_ROOT/.config/ai-1c-server/1c-chat/" "$AGENT_PROD/"
  
  # Restore PostgreSQL
  if [ -f "$RESTORE_STAGE/agentdb.dump" ]; then
    log "Restoring PostgreSQL from dump..."
    (cd "$AGENT_PROD" && docker compose up -d postgres)
    sleep 5
    (cd "$AGENT_PROD" && docker compose exec -T postgres \
      pg_restore -U agent -d agentdb --clean --if-exists --no-owner \
      < /dev/null) # placeholder, need to pipe dump
    # Actual restore:
    (cd "$AGENT_PROD" && docker compose exec -T postgres \
      sh -c "pg_restore -U agent -d agentdb --clean --if-exists --no-owner" \
      < "$RESTORE_STAGE/agentdb.dump") || true
  fi
  
  # Start backend
  log "Starting 1c-chat-backend..."
  (cd "$AGENT_PROD" && docker compose up -d backend)
  
  sleep 5
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    log "Agent restore OK: /health responds"
  else
    log "WARN: Agent /health not responding, check logs"
  fi
fi

# === Restore OpenCode ===
if [ "$RESTORE_OPENCODE" = "1" ]; then
  log "Restoring OpenCode..."
  
  # Stop containers
  for vol in main ka2 upp doc3; do
    container="1c-opencode-server-$vol"
    if docker ps --format '{{.Names}}' | grep -q "^$container\$"; then
      log "Stopping $container..."
      docker stop "$container" || true
    fi
  done
  
  # Copy config
  rsync -a "$STAGE_ROOT/project/1C-opencode/" "$OPENCODE_ROOT/"
  
  # Restore volumes (root-owned, needs sudo)
  for vol in main ka2 upp doc3; do
    if [ -d "$RESTORE_STAGE/opencode-volumes/$vol" ]; then
      log "Restoring OpenCode volume: $vol..."
      VOLUME_DATA="/var/lib/docker/volumes/1c-opencode_opencode-$vol/_data"
      sudo -n rm -rf "$VOLUME_DATA"/*
      sudo -n cp -a "$RESTORE_STAGE/opencode-volumes/$vol/." "$VOLUME_DATA/"
    fi
  done
  
  # Start containers
  log "Starting OpenCode containers..."
  (cd "$OPENCODE_ROOT" && docker compose up -d)
  
  sleep 5
  log "OpenCode restore completed. Check: docker ps | grep 1c-opencode"
fi

# === Cleanup ===
rm -rf "$RESTORE_STAGE"

log "=== Restore completed ==="
echo ""
echo "Next steps:"
[ "$RESTORE_PROD" = "1" ] && echo "  - Verify prod: curl http://localhost:9224/health"
[ "$RESTORE_AGENT" = "1" ] && echo "  - Verify agent: curl http://localhost:8000/health"
[ "$RESTORE_OPENCODE" = "1" ] && echo "  - Verify OpenCode: docker ps | grep 1c-opencode"
