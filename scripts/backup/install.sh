#!/usr/bin/env bash
# install.sh — установка бэкапа ai-1c-server
#
# Использование:
#   ./install.sh [--init-repo]
#
# Что делает:
#   1. Создаёт /home/test/.config/ai-1c-server/backup/
#   2. Копирует backup.conf.example -> backup.conf (если нет)
#   3. Генерирует restic.pass (если нет)
#   4. Опционально инициализирует restic репозиторий (--init-repo)
#   5. Устанавливает systemd-юниты (timer + service)
#   6. Запускает первый бэкап

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

INIT_REPO=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --init-repo) INIT_REPO=1; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done

log "=== Install backup ==="

# === 1. Create backup home ===
mkdir -p "$BACKUP_HOME"
chmod 700 "$BACKUP_HOME"

# === 2. Copy config ===
if [ ! -f "$BACKUP_HOME/backup.conf" ]; then
  cp "$SCRIPT_DIR/backup.conf.example" "$BACKUP_HOME/backup.conf"
  log "Created $BACKUP_HOME/backup.conf (edit if needed)"
else
  log "Config already exists: $BACKUP_HOME/backup.conf"
fi

# === 3. Generate restic password ===
if [ ! -f "$RESTIC_PASSWORD_FILE" ]; then
  openssl rand -base64 32 > "$RESTIC_PASSWORD_FILE"
  chmod 600 "$RESTIC_PASSWORD_FILE"
  log "Generated restic password: $RESTIC_PASSWORD_FILE"
  echo ""
  echo "IMPORTANT: Save this password in your password manager!"
  echo "Without it, backups cannot be decrypted if the server is lost."
  echo ""
else
  log "Restic password already exists: $RESTIC_PASSWORD_FILE"
fi

# === 4. Init restic repo ===
if [ "$INIT_REPO" = "1" ]; then
  mkdir -p "$(dirname "$RESTIC_REPOSITORY")"
  if ! RESTIC_REPOSITORY="$RESTIC_REPOSITORY" RESTIC_PASSWORD_FILE="$RESTIC_PASSWORD_FILE" restic snapshots >/dev/null 2>&1; then
    log "Initializing restic repo at $RESTIC_REPOSITORY"
    RESTIC_REPOSITORY="$RESTIC_REPOSITORY" RESTIC_PASSWORD_FILE="$RESTIC_PASSWORD_FILE" restic init
  fi
  log "Restic repo ready at $RESTIC_REPOSITORY"
else
  # Check if repo exists (direct env, no wrapper — avoids segfault on CIFS)
  if RESTIC_REPOSITORY="$RESTIC_REPOSITORY" RESTIC_PASSWORD_FILE="$RESTIC_PASSWORD_FILE" restic snapshots >/dev/null 2>&1; then
    log "Restic repo already exists at $RESTIC_REPOSITORY"
  else
    log "WARN: Restic repo not initialized. Run with --init-repo to create it."
  fi
fi

# === 5. Install systemd units ===
UNIT_DIR="$HOME_DIR/.config/systemd/user"
mkdir -p "$UNIT_DIR"

cp "$SCRIPT_DIR/systemd/ai-1c-backup.service" "$UNIT_DIR/"
cp "$SCRIPT_DIR/systemd/ai-1c-backup.timer" "$UNIT_DIR/"

systemctl --user daemon-reload
systemctl --user enable ai-1c-backup.timer
log "Systemd timer installed and enabled: ai-1c-backup.timer"

# === 6. First backup ===
if [ "$INIT_REPO" = "1" ]; then
  log "Running first backup..."
  "$SCRIPT_DIR/backup.sh"
else
  log "Skipping first backup (repo not initialized). Run manually:"
  echo "  $SCRIPT_DIR/backup.sh --no-prune"
fi

log "=== Install completed ==="
echo ""
echo "Status: systemctl --user status ai-1c-backup.timer"
echo "Logs:   journalctl --user -u ai-1c-backup.service -f"
echo "Manual: $SCRIPT_DIR/backup.sh"
