#!/bin/bash
# Синхронизация корпуса базы знаний из скрапера.
#
# Корпус лежит ВНЕ репозитория (/home/test/.config/ai-1c-server/kb) —
# он регулярно обновляется скрапером, и в git ему не место. Скрипт
# забирает свежие статьи и (по --ingest) сразу переинжестит их в базу.
#
# Использование:
#   scripts/sync_kb.sh                 # только синхронизировать файлы
#   scripts/sync_kb.sh --ingest        # + переинжест в dev-БД
#   scripts/sync_kb.sh --ingest --prod # + переинжест в prod-БД
#
# Пути задаются переменными:
#   SRC_DIR   — папка выгрузки скрапера
#   KB_DIR    — папка корпуса (монтируется в контейнер как /app/kb)
#   COLLECTION — имя коллекции внутри корпуса (по умолчанию updinfo)

set -euo pipefail

SRC_DIR="${SRC_DIR:-/home/test/.config/ai-1c-server/mcp/scraping_its/out/updinfo/markdown}"
KB_DIR="${KB_DIR:-/home/test/.config/ai-1c-server/kb}"
COLLECTION="${COLLECTION:-updinfo}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$REPO}"

INGEST=0
TARGET=dev
for arg in "$@"; do
  case "$arg" in
    --ingest) INGEST=1 ;;
    --prod) TARGET=prod ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: папка выгрузки скрапера не найдена: $SRC_DIR" >&2
  echo "Задай путь через SRC_DIR=..." >&2
  exit 1
fi

mkdir -p "$KB_DIR/$COLLECTION"
rsync -a --delete "$SRC_DIR/" "$KB_DIR/$COLLECTION/"
COUNT=$(find "$KB_DIR/$COLLECTION" -name '*.md' | wc -l)
echo "Синхронизировано: $COUNT файлов -> $KB_DIR/$COLLECTION"

if [ "$INGEST" = "1" ]; then
  if [ "$TARGET" = "prod" ]; then
    PROD_DIR="${PROD_DIR:-/home/test/.config/ai-1c-server/1c-chat}"
    echo "== Переинжест в prod =="
    (cd "$PROD_DIR" && docker compose exec -T backend uv run --frozen python scripts/ingest_kb.py \
      --dir "/app/kb/$COLLECTION" --collection "$COLLECTION" --replace)
  else
    echo "== Переинжест в dev =="
    (cd "$COMPOSE_DIR" && docker compose exec -T backend uv run --frozen python scripts/ingest_kb.py \
      --dir "/app/kb/$COLLECTION" --collection "$COLLECTION" --replace)
  fi
fi
