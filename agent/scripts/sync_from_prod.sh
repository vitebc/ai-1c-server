#!/usr/bin/env bash
# Синхронизация контента агентов ПРОД → DEV.
#
# Прод — источник истины для контента: backend/agents, backend/skills,
# backend/patterns правятся прод-админкой и коммитятся в git прода.
# Dev — зеркало: обновляется только отсюда, по явной команде.
# Обратного потока нет: deploy_prod.sh контент в прод не переносит.
#
# Использование (из корня монорепо или откуда угодно):
#   agent/scripts/sync_from_prod.sh            # dry-run: показать, что изменится
#   agent/scripts/sync_from_prod.sh --apply    # применить + коммит в монорепо
#
# Опции:
#   --apply            записать файлы (без флага — только dry-run)
#   --commit           оформить изменения коммитом (по умолчанию — да при --apply;
#                      --no-commit оставить рабочее дерево как есть)
#   --dir agents       синхронизировать только один каталог (agents|skills|patterns),
#                      можно повторять
#
# bases.conf / search-maps.conf НЕ синхронизируются: это окруженческие
# hot-reload файлы (адреса публикаций 1С), у каждого окружения свои.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONO="$(cd "$REPO/.." && pwd)"
PROD="${PROD_DIR:-/home/test/.config/ai-1c-server/1c-chat}"

APPLY=0
COMMIT=1
DIRS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --commit) COMMIT=1 ;;
    --no-commit) COMMIT=0 ;;
    --dir) shift; DIRS+=("$1") ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
  shift
done
[ ${#DIRS[@]} -eq 0 ] && DIRS=(agents skills patterns)

SRC_ROOT="$PROD/backend"
DST_ROOT="$REPO/backend"

if [ ! -d "$SRC_ROOT" ]; then
  echo "ERR: прод-каталог не найден: $SRC_ROOT (переопределите PROD_DIR)" >&2
  exit 1
fi

# Коммит прода, из которого берём контент (для подписи коммита в монорепо).
PROD_SHA="unknown"
if git -C "$PROD" rev-parse --git-dir >/dev/null 2>&1; then
  PROD_SHA="$(git -C "$PROD" rev-parse --short HEAD)"
fi

echo "== prod → dev: $SRC_ROOT → $DST_ROOT (prod@$PROD_SHA) =="
echo "   каталоги: ${DIRS[*]}"

# Страховка: незакоммиченные правки контента в dev не затираем молча.
DIRTY="$(git -C "$MONO" status --porcelain -- "agent/backend/${DIRS[0]}" \
  "agent/backend/${DIRS[1]}" "agent/backend/${DIRS[2]}" 2>/dev/null | grep -v '^??' || true)"
if [ -n "$DIRTY" ]; then
  echo "ERR: в dev есть незакоммиченные правки контента — закоммить или откати перед синком:" >&2
  echo "$DIRTY" >&2
  exit 1
fi

RSYNC_ARGS=(-a --delete --itemize-changes)
if [ "$APPLY" = "0" ]; then
  RSYNC_ARGS=(-a --delete --dry-run --itemize-changes)
fi

CHANGED=0
for d in "${DIRS[@]}"; do
  if [ ! -d "$SRC_ROOT/$d" ]; then
    echo "WARN: в проде нет $SRC_ROOT/$d — пропускаю" >&2
    continue
  fi
  mkdir -p "$DST_ROOT/$d"
  echo "-- $d"
  (cd "$SRC_ROOT" && rsync "${RSYNC_ARGS[@]}" "$d/" "$DST_ROOT/$d/")
  CHANGED=$((CHANGED + 1))
done
[ "$CHANGED" = "0" ] && { echo "Нечего синхронизировать."; exit 0; }

if [ "$APPLY" = "0" ]; then
  echo ""
  echo "DRY-RUN: изменения выше НЕ применены. Повторить с --apply."
  exit 0
fi

echo ""
echo "== Изменения в монорепо =="
git -C "$MONO" status --porcelain -- agent/backend | sed 's/^/   /'

if [ "$COMMIT" = "0" ]; then
  echo "COMMIT: пропущен (--no-commit), изменения оставлены в рабочем дереве."
  exit 0
fi

MSG="sync: prod 1c-chat@${PROD_SHA} → agent/backend (${DIRS[*]})"
git -C "$MONO" add -A -- "agent/backend/${DIRS[0]}" "agent/backend/${DIRS[1]}" "agent/backend/${DIRS[2]}"
if git -C "$MONO" diff --cached --name-only | grep -q .; then
  git -C "$MONO" commit -q -m "$MSG"
  echo "COMMIT: $(git -C "$MONO" rev-parse --short HEAD) — $MSG"
else
  echo "COMMIT: нечего коммитить (dev совпал с prod)."
fi

cat <<'EOF'

Бэкенд dev перечитывает agents/skills/patterns на каждый запрос —
рестарт контейнера не нужен. Если prod-контент менялся, а хочется
увидеть это в dev: agent/scripts/sync_from_prod.sh --apply
EOF