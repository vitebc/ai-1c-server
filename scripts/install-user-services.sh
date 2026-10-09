#!/bin/bash
# Поставить dev+prod демоны ai-1c-server как user-level systemd-сервисы:
#   - автоперезапуск при падении (Restart=always, RestartSec=5)
#   - watchdog: перезапуск, если /health молчит 60с (WatchdogSec=60)
#   - старт при логине/загрузке (linger включён — работает без сессии)
#
#   ./scripts/install-user-services.sh [dev|prod|all]   (по умолчанию all)
#
# Останавливает скриптовые инстансы (stop-dev.sh / adminka/stop.sh), если они
# запущены, и передаёт порты под управление systemd.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/ai-1c-server"
SCOPE="${1:-all}"

if ! systemctl --user is-system-running >/dev/null 2>&1 && [ ! -d /run/systemd/user ]; then
  echo "ERROR: user systemd не доступен (нет /run/systemd/user)"
  exit 1
fi

mkdir -p "$UNIT_DIR" "$ENV_DIR"

# Env-файлы: единый JWT-ключ с бэкендом 1С-агента (как в start-dev.sh/start.sh).
write_env() {
  local env_file="$1" agent_root="$2" label="$3"
  local jwt=""
  if [ -n "$agent_root" ] && [ -f "$agent_root/.env" ]; then
    jwt="$(grep '^JWT_SECRET=' "$agent_root/.env" | cut -d= -f2- || true)"
  fi
  {
    echo "# $label — env для systemd-user сервиса (создано install-user-services.sh)"
    [ -n "$jwt" ] && echo "JWT_SECRET=$jwt"
    [ "$label" = "prod" ] && echo "AGENT_ENV=prod"
  } > "$env_file"
  chmod 600 "$env_file"
}

install_one() {
  local name="$1" unit_src="$2" env_file="$3" stop_cmd="$4" agent_root="$5" label="$6"
  local svc="ai-1c-server-$name.service"

  cp "$unit_src" "$UNIT_DIR/$svc"
  write_env "$env_file" "$agent_root" "$label"

  # Остановить скриптовый инстанс, если жив (иначе systemd не сможет занять порт).
  if [ -n "$stop_cmd" ] && bash -c "$stop_cmd" >/dev/null 2>&1; then
    echo "[$name] остановлен скриптовый инстанс"
    sleep 1
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now "$svc"
  sleep 2
  if systemctl --user is-active --quiet "$svc"; then
    echo "[$name] $svc: active (systemd)"
  else
    echo "[$name] ERROR: $svc не стартовал:"
    systemctl --user --no-pager status "$svc" | head -10
    return 1
  fi
}

if [ "$SCOPE" = "dev" ] || [ "$SCOPE" = "all" ]; then
  install_one dev \
    "$DIR/scripts/systemd/user/ai-1c-server-dev.service" \
    "$ENV_DIR/dev.env" \
    "$DIR/scripts/stop-dev.sh" \
    "$HOME/project/1c-ai-agent" \
    "dev"
fi

if [ "$SCOPE" = "prod" ] || [ "$SCOPE" = "all" ]; then
  install_one prod \
    "$DIR/scripts/systemd/user/ai-1c-server-prod.service" \
    "$ENV_DIR/prod.env" \
    "/home/test/.config/ai-1c-server/adminka/stop.sh" \
    "$(sqlite3 /home/test/.config/ai-1c-server/adminka/data/db.sqlite "SELECT value FROM server_settings WHERE key='agent_project_root';" 2>/dev/null || true)" \
    "prod"
fi

echo ""
echo "Готово. Управление:"
echo "  systemctl --user status ai-1c-server-dev.service ai-1c-server-prod.service"
echo "  systemctl --user restart ai-1c-server-{dev,prod}.service"
echo "  journalctl --user -u ai-1c-server-{dev,prod}.service -f   (логи)"
