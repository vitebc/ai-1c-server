#!/usr/bin/env bash
# backup.sh — полный бэкап ai-1c-server (prod + agent + opencode + MCP)
#
# Использование:
#   ./backup.sh [--dry-run] [--no-prune] [--tag TAG]
#
# Что делает:
#   1. Создаёт staging в $STAGE_DIR
#   2. Делает консистентные дампы (SQLite .backup, pg_dump, OpenCode volumes)
#   3. Копирует конфиги/рабочие деревья в staging/root/home/test/...
#   4. Hardlink'ит крупные статические файлы (search-index, java, bsl-ls)
#   5. restic backup + retention
#   6. Чистит staging

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

# === Параметры ===
DRY_RUN=0
NO_PRUNE=0
TAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-prune) NO_PRUNE=1; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# === Настройка ===
mkdir -p "$BACKUP_HOME"
[ -f "$LOG_FILE" ] || touch "$LOG_FILE"

if [ ! -f "$RESTIC_PASSWORD_FILE" ]; then
  die "Restic password file not found: $RESTIC_PASSWORD_FILE"
fi

log "=== Backup started ==="
log "Repo: $RESTIC_REPOSITORY"
log "Stage: $STAGE_DIR"
log "Dry-run: $DRY_RUN, No-prune: $NO_PRUNE, Tag: ${TAG:-none}"

# === Проверка доступности шара ===
if [ ! -d "$(dirname "$RESTIC_REPOSITORY")" ]; then
  die "Backup target not accessible: $(dirname "$RESTIC_REPOSITORY")"
fi
if [ ! -w "$(dirname "$RESTIC_REPOSITORY")" ]; then
  die "Backup target not writable: $(dirname "$RESTIC_REPOSITORY")"
fi

# === Staging ===
stage_init

STAGE_ROOT="$STAGE_DIR/root/home/test"

# === 1. Prod adminka (без data/search-index, java, bsl-ls — они hardlink'ятся отдельно) ===
log "[1/8] Copying prod adminka..."
mkdir -p "$STAGE_ROOT/.config/ai-1c-server/adminka"
# Копируем всё кроме data/search-index, data/java, data/bsl-ls, server.log, server.pid
rsync -a \
  --exclude='data/search-index' \
  --exclude='data/java' \
  --exclude='data/bsl-ls' \
  --exclude='server.log' \
  --exclude='server.pid' \
  "$PROD_ADMINKA/" "$STAGE_ROOT/.config/ai-1c-server/adminka/"

# Consistent DB backup (заменяет копию db.sqlite)
sqlite_backup "$PROD_ADMINKA/data/db.sqlite" "$STAGE_ROOT/.config/ai-1c-server/adminka/data/db.sqlite"

# === 2. Env files + systemd units ===
log "[2/8] Copying env files and systemd units..."
mkdir -p "$STAGE_ROOT/.config/ai-1c-server"
cp -a "$HOME_DIR/.config/ai-1c-server/prod.env" "$STAGE_ROOT/.config/ai-1c-server/" 2>/dev/null || true
cp -a "$HOME_DIR/.config/ai-1c-server/dev.env" "$STAGE_ROOT/.config/ai-1c-server/" 2>/dev/null || true

mkdir -p "$STAGE_ROOT/.config/systemd/user"
for unit in ai-1c-server-prod.service ai-1c-server-dev.service; do
  cp -a "$HOME_DIR/.config/systemd/user/$unit" "$STAGE_ROOT/.config/systemd/user/" 2>/dev/null || true
done

# === 3. Agent (1c-chat) + pg_dump ===
log "[3/8] Copying agent (1c-chat)..."
mkdir -p "$STAGE_ROOT/.config/ai-1c-server"
rsync -a --exclude='logs/' "$AGENT_PROD/" "$STAGE_ROOT/.config/ai-1c-server/1c-chat/"

# PostgreSQL dump
PG_DUMP_FILE="$STAGE_DIR/agentdb.dump"
pg_dump "$AGENT_PROD" "postgres" "agentdb" "agent" "$PG_DUMP_FILE"

# === 4. OpenCode (config + volumes) ===
log "[4/8] Copying OpenCode config..."
mkdir -p "$STAGE_ROOT/project/1C-opencode"
rsync -a --exclude='node_modules/' "$OPENCODE_ROOT/" "$STAGE_ROOT/project/1C-opencode/"

# OpenCode volumes (root-owned, needs sudo)
for vol in main ka2 upp doc3; do
  opencode_volume_backup "1c-opencode_opencode-$vol" "$STAGE_DIR/opencode-volumes/$vol"
done

# === 5. MCP + skills + kb ===
log "[5/8] Copying MCP, skills, kb..."
mkdir -p "$STAGE_ROOT/.config/ai-1c-server"
rsync -a --exclude='node_modules/' --exclude='.git/' --exclude='target/' \
  "$MCP_DIR/" "$STAGE_ROOT/.config/ai-1c-server/mcp/"

if [ -d "$SKILLS_DIR" ]; then
  cp -a "$SKILLS_DIR" "$STAGE_ROOT/.config/ai-1c-server/skills"
fi

if [ -d "$KB_DIR" ]; then
  cp -a "$KB_DIR" "$STAGE_ROOT/.config/ai-1c-server/kb"
fi

# === 6. Dev data (без search-index) ===
log "[6/8] Copying dev data..."
mkdir -p "$STAGE_ROOT/project/ai-1c-server/data"
rsync -a --exclude='search-index/' "$DEV_REPO/data/" "$STAGE_ROOT/project/ai-1c-server/data/"

# Consistent dev DB backup
sqlite_backup "$DEV_REPO/data/db.sqlite" "$STAGE_ROOT/project/ai-1c-server/data/db.sqlite"

# === 7. Hardlink крупные статические файлы ===
if [ "${INCLUDE_SEARCH_INDEX:-1}" = "1" ]; then
  log "[7/8] Hardlinking search-index, java, bsl-ls..."
  # Prod data/search-index
  if [ -d "$PROD_ADMINKA/data/search-index" ]; then
    hardlink_copy "$PROD_ADMINKA/data/search-index" \
      "$STAGE_ROOT/.config/ai-1c-server/adminka/data/search-index"
  fi
  # Prod data/java, bsl-ls
  if [ -d "$PROD_ADMINKA/data/java" ]; then
    hardlink_copy "$PROD_ADMINKA/data/java" \
      "$STAGE_ROOT/.config/ai-1c-server/adminka/data/java"
  fi
  if [ -d "$PROD_ADMINKA/data/bsl-ls" ]; then
    hardlink_copy "$PROD_ADMINKA/data/bsl-ls" \
      "$STAGE_ROOT/.config/ai-1c-server/adminka/data/bsl-ls"
  fi
else
  log "[7/8] Skipping search-index (INCLUDE_SEARCH_INDEX=0)"
fi

# === 8. Git bundle + manifest ===
log "[8/8] Creating git bundle and manifest..."
mkdir -p "$STAGE_DIR/repo"
if [ -d "$DEV_REPO/.git" ]; then
  git -C "$DEV_REPO" bundle create "$STAGE_DIR/repo/ai-1c-server.bundle" --all 2>/dev/null || true
fi

write_manifest "$STAGE_DIR/MANIFEST.txt"

# === Restic backup ===
if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN: skipping restic backup"
  stage_cleanup
  exit 0
fi

ensure_repo

BACKUP_TAG="ai-1c-server"
[ -n "$TAG" ] && BACKUP_TAG="$BACKUP_TAG $TAG"

log "Running restic backup..."
restic backup \
  --tag "$BACKUP_TAG" \
  --host "$(hostname)" \
  "$STAGE_DIR/root" \
  "$STAGE_DIR/agentdb.dump" \
  "$STAGE_DIR/opencode-volumes" \
  "$STAGE_DIR/repo" \
  "$STAGE_DIR/MANIFEST.txt"

# === Retention ===
if [ "$NO_PRUNE" = "0" ]; then
  log "Running restic forget + prune..."
  restic forget \
    --tag "ai-1c-server" \
    --keep-daily "${KEEP_DAILY:-14}" \
    --keep-weekly "${KEEP_WEEKLY:-8}" \
    --keep-monthly "${KEEP_MONTHLY:-12}" \
    --prune
fi

# === Cleanup ===
stage_cleanup

log "=== Backup completed successfully ==="
restic snapshots --last 5
