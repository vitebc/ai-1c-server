# AI 1C Enterprise Server

Сервер на Rust (Axum + SQLite + Tokio) с React SPA-админкой.
Централизованное управление MCP-серверами, конфигурациями 1С
и развёртывание клиентов в команде разработчиков.

**Разделение dev/prod:** ветка `master` — разработка (dev-демон на :9225,
`data/`, админка из репо). Prod живёт ОТДЕЛЬНО в
`/home/test/.config/ai-1c-server/adminka` — там только то, что нужно для
запуска: бинарник, `admin-ui/dist`, `migrations/`, своя `data/`, скрипты
start/stop/status/restart. Выкатка в prod — `scripts/deploy.sh`.
Данные не пересекаются: dev пишет в `<repo>/data`, prod — в `adminka/data`.

**Правило безопасности:** после каждого изменения — локальный коммит
(`git add -A && git commit`). Если файл в `.gitignore` (не коммитится: `data/`, `admin-ui/dist/`,
`server.log`, `*.jar`) — сделать бэкап вручную (например,
`cp adminka/data/db.sqlite /tmp/opencode/db.sqlite.bak-<ts>` для prod) перед
опасной операцией. Не делать «большой» коммит в конце сессии.

**Правило верстки:** для любой работы с UI/версткой админки (`admin-ui/`)
обязательно использовать скил `ui-ux-pro-max` — консультироваться по
типографике, spacing, цветам, доступности и паттернам компоновки.

## Состояние проекта

Работающие блоки (все покрыты API + UI):

- **Ядро** — `src/main.rs` (clap CLI: `migrate` + `run` по умолчанию, флаги
  `--data-dir`, `--http-port`, `--admin-dir`), `src/db/` (SQLite rusqlite
  bundled + авто-применение миграций), `GET /health`, кольцевой буфер логов
  (`src/log_buffer.rs`, 1000 записей), `src/web/` (embedded `admin-ui/dist`
  через `rust-embed`).
- **MCP Gateway** — `src/mcp/`: менеджер сессий с двумя транспортами
  (`ManagedSession::Stdio` — subprocess + JSON-RPC через stdio,
  `ManagedSession::Http` — входящий Streamable HTTP-клиент для удалённых
  серверов, `src/mcp/http_session.rs`), авто-`initialize`, hot-reload при
  CRUD, `bsl_ls.rs` (BSL Language Server), `skill_loader.rs` (серверные
  скиллы → MCP-тулзы), `protocol.rs`, `session.rs`, `config.rs`.
- **MCP HTTP-шлюз** — `src/api/mcp_http.rs` + `src/api/mcp.rs`:
  `POST /api/mcp-aggregated/mcp` (все серверы, имена `server__tool`),
  `GET` там же — SSE, per-server `/api/mcp/{id|name}/mcp`,
  REST-инвентарь тулзов (`/api/mcp`, `/api/mcp-aggregated/tools`,
  `/api/mcp/{id|name}/tools`). `src/api/mcp_skills.rs` — скиллы как MCP.
- **Auth / RBAC** — `src/auth/mod.rs`: users в БД (argon2id), JWT 12h/7d,
  legacy machine-token, 4 роли, 19 секций, матрица ролей, rate-limit логина.
- **Admin CRUD API** — `src/api/admin/`: mcp_servers, skills,
  config_profiles, client_versions, clients, status, dashboard, settings,
  logs, fs, users, model_providers, bsl_ls, agent_files, agent_backend.
- **Admin UI** (React 19 + Vite 7 + Tailwind CSS v4 + react-router 7):
  Dashboard, MCP Servers, Models, Agent Studio, Skills, BSL LS, Configs,
  Client Versions, Clients, Logs, Users. Тёмная тема, i18n (ru),
  общие компоненты в `components/ui.tsx`.

Заглушки (модули есть, логики нет): `src/watcher/` (fsnotify-реиндекс),
`src/updater/` (версионирование клиентских сборок).

## Сборка и разработка

```bash
# Dev-демон (master, порт 9225, data/)
./scripts/start-dev.sh
./scripts/stop-dev.sh

# Prod (порт 9224) — живёт в adminka/, скрипты там же:
/home/test/.config/ai-1c-server/adminka/start.sh   # CWD = adminka
/home/test/.config/ai-1c-server/adminka/stop.sh    # + fallback на сироту по порту
/home/test/.config/ai-1c-server/adminka/status.sh  # restart.sh — stop+start

# Выкатка в prod (сборка + копирование + рестарт)
./scripts/deploy.sh      # ADM_DIR=... для переопределения пути prod

# Dev (раздельные процессы, hot-reload)
cd admin-ui && npm run dev          # Vite на :5173
cargo run -- --data-dir ./data      # Rust сервер на :9224 (локальная отладка)

# Admin UI отдельно
cd admin-ui && npm install && npm run build

# Сервис (systemd)
sudo ./scripts/install-service.sh   # + service-status.sh / service-logs.sh / uninstall-service.sh
```

- `start.sh` сам гоняет `migrate`, ждёт `/health` ~15 c, пишет `server.log`
  и `server.pid`; отказывается стартовать, если порт уже занят.
- Переопределяются env: `PORT`, `DATA_DIR` (дефолт `<dir>/data`).
- Миграции читаются из `./migrations` относительно CWD — prod-скрипты
  запускают бинарник с CWD = adminka, поэтому там лежит копия migrations.
- Бинарник: `ai-1c-server` (не `mini-ai-1c-server`).

### Обязательный цикл выката

```bash
# Dev: собрать и проверить на 9225
cd admin-ui && npm run build                        # НЕ коммитить при "error TS"
touch src/main.rs && cargo build --release --target x86_64-unknown-linux-gnu
git add -A && git commit -m "..."

# Prod: выкатка (build + копирование в adminka/ + рестарт)
./scripts/deploy.sh
curl -s http://localhost:9224/ | grep -o 'index-[^"]*\.js'   # бандл обновился?
```

**Правило:** prod (`deploy.sh`) накатывать ТОЛЬКО после явного подтверждения
пользователя («накати прод», «деплой» и т.п.). После коммита и проверки на dev —
спросить, не запускать deploy самостоятельно.

`npm run build` не останавливается на ошибках tsc — при `error TS...`
в выводе коммит не делать и deploy.sh прервётся (иначе уедет сломанный
бандл в прод).

Перед добавлением нового модуля: создать `mod.rs` и зарегистрировать
в `main.rs`.

## Архитектура

```
main.rs           — точка входа, clap CLI
├── api/          — Axum route handlers
│   ├── admin/    — CRUD, RBAC-секции, agent-files/agent_backend
│   ├── mcp.rs, mcp_http.rs, mcp_skills.rs  — MCP HTTP/SSE шлюз
│   └── mod.rs    — сборка роутов, 404 для неизвестных /api/*
├── db/           — SQLite через rusqlite (bundled) + миграции
├── mcp/          — lifecycle сессий (stdio|http), JSON-RPC, BSL LS, скиллы
├── auth/         — argon2 + JWT + RBAC (роли, секции, rate-limit)
├── log_buffer.rs — кольцевой буфер логов + distinct targets
├── watcher/      — заглушка (fsnotify для авто-реиндекса)
├── updater/      — заглушка (версии клиентских сборок)
└── web/          — embedded admin-ui/dist (rust-embed)
```

Миграции: `001_initial.sql` (mcp_servers, skills, config_profiles,
client_versions, clients, server_settings, audit_log),
`002_add_instruction.sql`, `003_config_parent.sql`, `004_users.sql`,
`005_model_providers.sql`.

## RBAC (кратко, детали в `src/auth/mod.rs`)

- 19 секций: `dashboard, mcp-servers, models, agent-studio, agent-agents,
  agent-skills, agent-patterns, agent-backend, skills, bsl-ls, configs,
  client-versions, clients, logs, settings, fs, env, users, auth-manage`.
- 4 роли: `admin` (всегда full, не настраивается), `operator` (все
  рабочие разделы), `viewer` (read-only), `prompter` (read-only, но пишет
  `agent-files/agents|skills|patterns`).
- Дефолты ролей переопределяются админом через `server_settings.role_sections`
  (матрица ролей, `GET/PUT /users/roles`).
- Per-user `sections` — только ВЫчитание из секций своей роли; выдача вне
  роли делается только через матрицу ролей.
- Свой пароль может менять кто угодно; свою роль/enable — нельзя; свои
  секции — нельзя никому, кроме admin.
- `auth_required` (по умолчанию 1) гейтит **только** MCP-шлюз; админка
  всегда логин/пароль (machine-токен → 401).

## Prod (adminka)

- Prod-директория: `/home/test/.config/ai-1c-server/adminka` (вне git,
  паттерн как у `1c-chat`). Состав: `ai-1c-server` (бинарник),
  `admin-ui/dist/`, `migrations/`, `data/` (своя копия: БД, bsl-ls/, java/,
  skills/), `start.sh` / `stop.sh` / `status.sh` / `restart.sh`,
  `server.log`, `server.pid`. Порт 9224.
- Обновление — только через `scripts/deploy.sh`: build → копирование
  бинарника/dist/migrations → stop+start. `data/` deploy не трогает.
- `<repo>/data` в git не попадает; это данные dev-демона. Prod пишет только
  в `adminka/data`.

## Ключевые факты

- **`data/` в `.gitignore`** — runtime dev-демона (БД, индексы, сборки,
  BSL LS JAR); у prod своя `data/` в adminka.
- **`admin-ui/dist/`** вшивается в бинарник через `rust-embed`; в git не
  попадает (`.gitignore`), собирается всегда перед `cargo build`.
- **Тесты отсутствуют** (ни Rust, ни JS). Проверка фичи = временный объект
  через API (юзер/провайдер/агент), проверка кодов 200/400/403/404,
  удаление, восстановление состояния, затем commit+push.
- **Все MCP-серверы клиента** (1c-help, 1c-search, 1c-naparnik, 1c-metadata,
  BSL LS) живут на этом сервере; клиенты ходят по HTTP/WS. На клиенте
  остаётся EditorBridge (.NET named pipes).
- **Скиллы/агенты бэкендом перечитываются на каждый запрос** — рестарт
  сервера и бэкенда не нужен. В UI у скилла есть live-точка видимости
  (зелёная — бэкенд видит, жёлтая — доступен, но не в live-списке).
- **Дашборд** — один `GET /dashboard` вместо шести запросов; числа видны
  всем залогиненным (секция `dashboard` есть у всех ролей).
- **Пользовательские правки в `admin-ui`** (тёмная тема, i18n, `ui.tsx`,
  `errors.ts`, рескин страниц) лежат в дереве отдельными коммитами —
  не перетирать при правках.
- **Известный долг**: в `AgentStudio.tsx` / `McpServers.tsx` встречаются
  склеенные строки (мои правки без отступов) — работает, но неаккуратно.

## Документация

- `API.md` — HTTP API (актуально, обновляется вместе с роутами).
- `SETUP.md` — установка/развёртывание на VPS, systemd, MCP-клиенты.
