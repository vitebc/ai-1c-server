# Резервное копирование ai-1c-server

## Обзор

Полное резервирование ai-1c-server (prod + agent + OpenCode + MCP) в зашифрованный restic-репозиторий на CIFS-шаре `/home/test/zhvv/ai_backup`.

**Цели:**
- Откат плохого деплоя за 2–5 минут
- Восстановление после потери данных
- DR на другом сервере (30–60 минут)

**RPO:** 24 часа (ночной бэкап) + pre-deploy снимки перед каждым `deploy.sh`  
**RTO:** откат деплоя ~5 мин, полный DR ~30–60 мин

## Состав бэкапа

| Компонент | Что | Размер |
|---|---|---|
| Prod adminka | `db.sqlite` (consistent), бинарник, `admin-ui/dist`, миграции, скрипты | ~20 МБ + БД |
| Search indexes | `data/search-index/*.db` | 5.5 ГБ |
| Java + BSL LS | `data/java/`, `data/bsl-ls/` | 471 МБ |
| Agent (1c-chat) | Рабочее дерево, `.env`, `.git`, PostgreSQL dump (`agentdb`) | ~26 МБ + 90 МБ |
| OpenCode | `config/*` (без `node_modules`), `.env`, `.git`, volumes с историей | ~57 МБ + 98 МБ |
| MCP | Бинарники, конфиги, репозитории (без `node_modules`) | ~270 МБ |
| Прочее | `kb/`, `skills/`, `workspace/tools/`, systemd-юниты, env-файлы | ~40 МБ |
| Dev data | `data/db.sqlite`, `data/opencode/`, `data/java/`, `data/bsl-ls/` (без `search-index`) | ~650 МБ |
| Git bundle | Все ветки/теги репозитория + commit/status | ~5–40 МБ |

**Итого:** ~7.3 ГБ первый снимок, дальше дельта 100–400 МБ/сутки (deduplication).

## Что НЕ входит

- **Исходники 1С** (`workspace/*`, 89 ГБ) — восстанавливаются ночной синхронизацией
- **Индексы code-index** (внутри `workspace/*/.code-index`) — пересобираются `reindex.sh`
- **Docker-образы** — пересобираются/пулятся
- **`node_modules`, Rust `target`, логи, кэши**
- **Gitea, OpenChamber, OpenClaw** — отдельные продукты

## Установка

```bash
cd /home/test/project/ai-1c-server/scripts/backup
./install.sh --init-repo
```

Скрипт:
1. Создаёт `~/.config/ai-1c-server/backup/`
2. Копирует `backup.conf.example` → `backup.conf`
3. Генерирует `restic.pass` (chmod 600) — **сохраните в password manager**
4. Инициализирует restic репозиторий на шаре
5. Устанавливает systemd-юниты (timer + service)
6. Запускает первый бэкап

## Ежедневный бэкап

Systemd-user timer `ai-1c-backup.timer` запускается ежедневно в 03:30 UTC (±15 мин).

```bash
# Статус
systemctl --user status ai-1c-backup.timer

# Логи
journalctl --user -u ai-1c-backup.service -f

# Ручной запуск
./scripts/backup/backup.sh
```

## Pre-deploy снимки

`scripts/deploy.sh` автоматически создаёт снимок перед выкаткой:
- Бинарник, `admin-ui/dist`, миграции
- Consistent DB backup (`sqlite3 .backup`)
- Манифест (commit, branch, timestamp)

Хранятся в `$ADM_DIR/backups/pre-deploy-<timestamp>/` (5 последних).

## Восстановление

```bash
# Список снапшотов
./scripts/backup/restore.sh --list

# Dry-run: показать что будет восстановлено
./scripts/backup/restore.sh --snapshot latest --prod --dry-run

# Восстановить prod
./scripts/backup/restore.sh --snapshot latest --prod

# Восстановить agent (1c-chat + PostgreSQL)
./scripts/backup/restore.sh --snapshot latest --agent

# Восстановить OpenCode (config + volumes)
./scripts/backup/restore.sh --snapshot latest --opencode

# Всё сразу
./scripts/backup/restore.sh --snapshot latest --full
```

### Откат плохого деплоя

1. Найдите последний pre-deploy снимок: `ls -lt ~/.config/ai-1c-server/adminka/backups/`
2. Остановите prod: `systemctl --user stop ai-1c-server-prod.service`
3. Скопируйте файлы из снимка в `adminka/`
4. Запустите prod: `systemctl --user start ai-1c-server-prod.service`

### DR на другом сервере

1. Установите restic, скопируйте `restic.pass`
2. `restic snapshots` — выберите нужный снапшот
3. `./restore.sh --snapshot <id> --full --target /tmp/dr-restore`
4. Скопируйте `/tmp/dr-restore/var/tmp/ai-1c-backup/root/home/test/` на целевой сервер
5. **Перезапишите абсолютные пути** в `server_settings`:
   - `search_index_dir`, `bsl_ls_java_path`, `bsl_ls_jar_path`
   - `agent_project_root`, `opencode_project_root`
6. Проверьте IP-зависимые настройки:
   - `AGG_MCP_URL` (в `1c-chat/.env`)
   - `ONEC_GATEWAY_URL` (в `1C-opencode/docker-compose.yml`)
   - LLM/embeddings endpoints (192.168.60.106)

## Проверка целостности

```bash
# Быстрая проверка (10% данных)
./scripts/backup/verify.sh

# Полная проверка (все данные)
./scripts/backup/verify.sh --full
```

Скрипт:
1. `restic check --read-data-subset=10%` (или `--read-data`)
2. Восстанавливает последний снапшот во временный каталог
3. Проверяет SQLite `integrity_check` для всех БД
4. Проверяет `pg_restore --list` для agentdb.dump
5. Показывает MANIFEST.txt

## Конфигурация

`~/.config/ai-1c-server/backup/backup.conf`:

```bash
RESTIC_REPOSITORY=/home/test/zhvv/ai_backup/restic
RESTIC_PASSWORD_FILE=~/.config/ai-1c-server/backup/restic.pass
STAGE_DIR=/var/tmp/ai-1c-backup
LOG_FILE=~/.config/ai-1c-server/backup/backup.log

# Retention
KEEP_DAILY=14
KEEP_WEEKLY=8
KEEP_MONTHLY=12

# Включить search-index (1=да, 0=нет)
INCLUDE_SEARCH_INDEX=1
```

## Уведомления

При ошибке бэкап шлёт уведомление через `notify_error.sh` в IRC #error.

## Важные замечания

1. **Restic password** — единственный способ расшифровать бэкапы. Сохраните его в password manager и скопируйте off-server.
2. **CIFS segfault** — restic 0.18.1 падает с segfault при вызове через shell-функцию с env-переменными на CIFS/autofs. Скрипты передают env прямо в вызов.
3. **Root-owned files** — `service.json` (OpenCode) и docker volumes принадлежат root. Скрипты используют `sudo -n` для доступа.
4. **Staging** — бэкап создаёт staging в `/var/tmp/ai-1c-backup` (~7 ГБ). Убедитесь, что достаточно места на локальном диске.
