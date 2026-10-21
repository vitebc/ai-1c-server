#!/usr/bin/env bash
# Накатка prod: build образа из кода монорепо + синхронизация runtime-файлов в
# prod-директорию. Prod — /home/test/.config/ai-1c-server/1c-chat.
#
# Контент (backend/agents, backend/skills, backend/patterns) деплой НЕ трогает:
# прод — источник истины, файлы правятся прод-админкой и коммитятся в git
# прода. Dev-контент в prod не попадает. Обновление dev из prod — отдельно,
# по команде: scripts/sync_from_prod.sh.
#
# Использование:
#   scripts/deploy_prod.sh          # из master после git push
#   SYNC_AGENT_CONTENT=1 scripts/deploy_prod.sh   # аварийно: rsync новых файлов контента
#
# Не трогает .env и БД prod. Откат: docker compose up -d --no-build в старой копии.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROD="${PROD_DIR:-/home/test/.config/ai-1c-server/1c-chat}"

if [ ! -d "$PROD" ]; then
  echo "Prod-директория не найдена: $PROD (переопределите PROD_DIR)" >&2
  exit 1
fi

# Только из основной ветки монорепо (master) — dev-правки в prod не накатываются.
BRANCH="$(git -C "$REPO" branch --show-current)"
case "$BRANCH" in
  master|main) ;;
  *)
    echo "Deploy только из master/main (сейчас: $BRANCH). git checkout master && git pull" >&2
    exit 1
    ;;
esac

echo "== Build образа из main (no-cache: src/ обязана быть свежей) =="
# Dev-образ собирается как 1c-ai-agent-backend:dev, prod-compose ждёт :latest —
# без тега prod молча поднимет старый образ (проверено: дубль кода не накатывался).
(cd "$REPO" && docker compose build --no-cache backend && \
  docker tag "${BACKEND_IMAGE:-1c-ai-agent-backend}:dev" "${BACKEND_IMAGE:-1c-ai-agent-backend}:latest")

echo "== Синхронизация runtime-файлов в $PROD =="
# Контент (agents/skills/patterns) НЕ синхронизируется: прод — источник
# истины, его файлы правятся прод-админкой и коммитятся в git прода.
# Dev-контент в prod не попадает вообще. Обратное направление (prod → dev) —
# отдельно, по команде: scripts/sync_from_prod.sh.
#
# Аварийный флаг SYNC_AGENT_CONTENT=1 возвращает старое поведение
# (rsync --ignore-existing: в prod доезжают только НОВЫЕ файлы).
if [ "${SYNC_AGENT_CONTENT:-0}" = "1" ]; then
  echo "WARN: SYNC_AGENT_CONTENT=1 — добавляю новые файлы контента из dev в prod" >&2
  for d in agents skills patterns; do
    mkdir -p "$PROD/backend/$d"
    rsync -a --ignore-existing "$REPO/backend/$d/" "$PROD/backend/$d/"
  done
fi

# Одиночные hot-reload файлы окружения. Копируются только при отсутствии:
# их правят на хосте, деплой не перезаписывает. Если путь существует, но это
# КАТАЛОГ (былый случай: search-maps.conf в prod создан как пустой каталог) —
# не трогаем и предупреждаем: бэкенд читает мапу как отсутствующую (OSError)
# и фильтр search-серверов по базам не применяется.
for f in bases.conf search-maps.conf; do
  dst="$PROD/backend/$f"
  if [ -d "$dst" ]; then
    echo "WARN: $dst — каталог, а не файл; пропускаю (мапа не применяется)" >&2
  elif [ ! -e "$dst" ]; then
    cp "$REPO/backend/$f" "$dst"
  fi
done
cp "$REPO/backend/Dockerfile" "$PROD/backend/Dockerfile"
mkdir -p "$PROD/backend/alembic"
rsync -a --delete "$REPO/backend/alembic/" "$PROD/backend/alembic/"
cp "$REPO/backend/alembic.ini" "$PROD/backend/alembic.ini"

# Корпус базы знаний в prod НЕ едет: он лежит вне репозитория
# (KB_HOST_DIR, по умолчанию /home/test/.config/ai-1c-server/kb) — общий
# для dev и prod, обновляется скрапером. В compose он примонтирован
# только на чтение.

echo "== Перезапуск backend (force-recreate: гарантируем новый образ) =="
(cd "$PROD" && docker compose up -d --force-recreate backend)

echo "== Проверка =="
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    echo "OK: $(curl -s http://localhost:8000/health)"
    exit 0
  fi
  sleep 3
done
echo "FAIL: /health не отвечает через 90с. (cd $PROD && docker compose logs backend)" >&2
exit 1
