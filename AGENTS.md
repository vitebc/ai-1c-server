# AI 1C Enterprise Server

Сервер на Rust (Axum + SQLite + Tokio) с React SPA-админкой.
Централизованное управление MCP-серверами, конфигурациями 1С
и развёртывание клиентов в команде разработчиков.

## Состояние проекта

Завершён этап 1 из 11 (каркас):
- `src/main.rs` — CLI с subcommand `migrate` + `run` (default)
- `src/db/` — SQLite init + авто-применение миграций из `migrations/`
- GET `/health` — живой endpoint
- Admin UI (React 19 + Vite): скелет, Tailwind НЕ подключён
- Модули (`api/`, `db/`, `mcp/`, `auth/`, `watcher/`, `updater/`, `web/`) — `mod.rs` созданы

## Сборка и разработка

```bash
# Production (двухэтапная: admin-ui → cargo)
.\scripts\build-windows.ps1        # Windows
./scripts/build-linux.sh           # Linux

# Dev (раздельные процессы)
cd admin-ui && npm run dev          # Vite на :5173
cargo run -- --data-dir ./data      # Rust сервер на :9224

# Admin UI отдельно
cd admin-ui && npm install && npm run build
```

Бинарник: `ai-1c-server` (не `mini-ai-1c-server`).

Перед добавлением нового модуля: создать `mod.rs` и зарегистрировать в `main.rs`.

## Архитектура

```
main.rs           — точка входа, clap CLI
├── api/          — Axum route handlers (client + admin CRUD)
├── db/           — SQLite через rusqlite (bundled)
├── mcp/          — subprocess lifecycle + JSON-RPC proxy
├── auth/         — токен-аутентификация (jsonwebtoken)
├── watcher/      — fsnotify для авто-реиндекса
├── updater/      — версионирование и раздача клиентских сборок
└── web/          — embedded admin-ui/dist (rust-embed)
```

## Ключевые факты

- **`data/` в `.gitignore`** — runtime-директория (БД, индексы, сборки)
- **`admin-ui/dist/`** вшивается в бинарник через `rust-embed`
- **Миграции БД**: `migrations/001_initial.sql` (7 таблиц)
- **Зависимости**: см. `Cargo.toml` (включая `tower`, которого нет в старой схеме)
- **Тесты отсутствуют** (ни Rust, ни JS)
- **Все MCP-серверы клиента** (1c-help, 1c-search, 1c-naparnik, 1c-metadata, BSL LS) запускаются на этом сервере, клиенты подключаются по HTTP/WS. На клиенте остаётся EditorBridge (.NET named pipe)
