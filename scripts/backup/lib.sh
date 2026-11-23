#!/usr/bin/env bash
# lib.sh — общие функции для backup.sh / restore.sh / verify.sh
set -euo pipefail

# === Пути (переопределяются в backup.conf) ===
: "${BACKUP_HOME:=/home/test/.config/ai-1c-server/backup}"
: "${RESTIC_REPOSITORY:=/home/test/zhvv/ai_backup/restic}"
: "${RESTIC_PASSWORD_FILE:=$BACKUP_HOME/restic.pass}"
: "${STAGE_DIR:=/var/tmp/ai-1c-backup}"
: "${LOG_FILE:=$BACKUP_HOME/backup.log}"

# === Константы окружения ===
HOME_DIR="${HOME_DIR:-/home/test}"
PROD_ADMINKA="$HOME_DIR/.config/ai-1c-server/adminka"
DEV_REPO="$HOME_DIR/project/ai-1c-server"
AGENT_PROD="$HOME_DIR/.config/ai-1c-server/1c-chat"
OPENCODE_ROOT="$HOME_DIR/project/1C-opencode"
MCP_DIR="$HOME_DIR/.config/ai-1c-server/mcp"
SKILLS_DIR="$HOME_DIR/.config/ai-1c-server/skills"
KB_DIR="$HOME_DIR/.config/ai-1c-server/kb"
CODE_INDEX_DIR="$HOME_DIR/.config/ai-1c-server/code-index"
WORKSPACE_TOOLS="$HOME_DIR/.config/ai-1c-server/workspace/tools"

# === Логирование ===
log() {
  local ts
  ts="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo "[$ts] $*" | tee -a "$LOG_FILE" 2>/dev/null || echo "[$ts] $*"
}

die() {
  log "ERROR: $*"
  exit 1
}

# === Уведомления ===
notify_error() {
  local job="$1"; shift
  local details="$*"
  local notify_script="$WORKSPACE_TOOLS/obrabotki/notify_error.sh"
  if [ -x "$notify_script" ]; then
    log "NOTIFY: $job — $details"
    "$notify_script" "$job" "$details" || true
  else
    log "WARN: notify script not found at $notify_script"
  fi
}

# === Restic helpers ===
# NOTE: не оборачивать restic в shell-функцию с env-переменными —
# segfault на CIFS (autofs). Передаём env прямо в вызов.
ensure_repo() {
  if ! RESTIC_REPOSITORY="$RESTIC_REPOSITORY" RESTIC_PASSWORD_FILE="$RESTIC_PASSWORD_FILE" \
    restic snapshots >/dev/null 2>&1; then
    log "Initializing restic repo at $RESTIC_REPOSITORY"
    mkdir -p "$(dirname "$RESTIC_REPOSITORY")"
    RESTIC_REPOSITORY="$RESTIC_REPOSITORY" RESTIC_PASSWORD_FILE="$RESTIC_PASSWORD_FILE" \
      restic init
  fi
}

# === SQLite consistent backup ===
sqlite_backup() {
  local src="$1" dst="$2"
  [ -f "$src" ] || return 0
  sqlite3 "$src" ".backup '$dst'"
  # Verify integrity of the backup
  local result
  result="$(sqlite3 "$dst" 'PRAGMA integrity_check;')"
  [ "$result" = "ok" ] || die "SQLite integrity check failed for $src: $result"
  log "SQLite backup OK: $src -> $dst ($(du -h "$dst" | cut -f1))"
}

# === PostgreSQL dump ===
pg_dump() {
  local compose_dir="$1" service="$2" db="$3" user="$4" dst="$5"
  (cd "$compose_dir" && docker compose exec -T "$service" \
    pg_dump -U "$user" -d "$db" -Fc) > "$dst"
  [ -s "$dst" ] || die "pg_dump produced empty file: $dst"
  log "PostgreSQL dump OK: $compose_dir/$service/$db -> $dst ($(du -h "$dst" | cut -f1))"
}

# === OpenCode volume DB backup (root-owned, needs sudo) ===
opencode_volume_backup() {
  local volume_name="$1" dst_dir="$2"
  local src="/var/lib/docker/volumes/$volume_name/_data"
  # /var/lib/docker is root:root 710 — test as root
  sudo -n test -d "$src" || return 0
  mkdir -p "$dst_dir"
  # Copy opencode.db with sqlite .backup (consistent)
  if sudo -n test -f "$src/opencode.db"; then
    sudo -n sqlite3 "$src/opencode.db" ".backup '$dst_dir/opencode.db'"
    local result
    result="$(sqlite3 "$dst_dir/opencode.db" 'PRAGMA integrity_check;')"
    [ "$result" = "ok" ] || die "OpenCode DB integrity check failed: $volume_name"
  fi
  # Copy shell/ and tool-output/ (small state dirs)
  for d in shell tool-output repos; do
    if [ -d "$src/$d" ]; then
      sudo -n cp -a "$src/$d" "$dst_dir/"
    fi
  done
  log "OpenCode volume backup OK: $volume_name -> $dst_dir ($(du -sh "$dst_dir" | cut -f1))"
}

# === Hardlink copy (for large static files) ===
hardlink_copy() {
  local src="$1" dst="$2"
  [ -d "$src" ] || return 0
  mkdir -p "$dst"
  cp -al "$src/." "$dst/" 2>/dev/null || {
    # Fallback to regular copy if hardlink fails (cross-device, etc.)
    log "WARN: hardlink failed for $src, using regular copy"
    cp -a "$src/." "$dst/"
  }
}

# === Manifest ===
write_manifest() {
  local dst="$1"
  {
    echo "# ai-1c-server backup manifest"
    echo "timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "hostname=$(hostname)"
    echo "user=$(whoami)"
    echo ""
    echo "# Git commits"
    if [ -d "$DEV_REPO/.git" ]; then
      echo "repo_commit=$(git -C "$DEV_REPO" rev-parse HEAD 2>/dev/null || echo 'unknown')"
      echo "repo_branch=$(git -C "$DEV_REPO" branch --show-current 2>/dev/null || echo 'detached')"
    fi
    if [ -d "$AGENT_PROD/.git" ]; then
      echo "agent_commit=$(git -C "$AGENT_PROD" rev-parse HEAD 2>/dev/null || echo 'unknown')"
    fi
    if [ -d "$OPENCODE_ROOT/.git" ]; then
      echo "opencode_commit=$(git -C "$OPENCODE_ROOT" rev-parse HEAD 2>/dev/null || echo 'unknown')"
    fi
    echo ""
    echo "# Service status"
    systemctl --user is-active ai-1c-server-prod.service 2>/dev/null | sed 's/^/prod_service=/'
    systemctl --user is-active ai-1c-server-dev.service 2>/dev/null | sed 's/^/dev_service=/'
    docker ps --format '{{.Names}}: {{.Status}}' 2>/dev/null | head -20
    echo ""
    echo "# DB sizes"
    [ -f "$PROD_ADMINKA/data/db.sqlite" ] && echo "prod_db=$(du -h "$PROD_ADMINKA/data/db.sqlite" | cut -f1)"
    [ -f "$DEV_REPO/data/db.sqlite" ] && echo "dev_db=$(du -h "$DEV_REPO/data/db.sqlite" | cut -f1)"
  } > "$dst"
  log "Manifest written: $dst"
}

# === Staging setup/cleanup ===
stage_init() {
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR/root/home/test"
  chmod 700 "$STAGE_DIR"
  log "Staging initialized: $STAGE_DIR"
}

stage_cleanup() {
  rm -rf "$STAGE_DIR"
  log "Staging cleaned up"
}
