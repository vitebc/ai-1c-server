# Mini AI 1C Enterprise Server

Серверное приложение для централизованного управления MCP-серверами, конфигурациями 1С и развёртывания Mini AI 1C в команде разработчиков.

## Архитектура

```
mini-ai-1c-server (Rust, один бинарник Linux/Windows)
│
├── Config API      — раздача клиентских конфигураций
├── MCP Gateway     — HTTP → stdio proxy для MCP-серверов
├── Skills Registry — база MCP-инструментов для AI-агента
├── File Watcher    — авто-реиндексация при изменении конфигураций
├── Updater         — хранение и раздача клиентских сборок
├── Admin Dashboard — встроенная React SPA
└── Auth            — токен-аутентификация
```

### Клиент (mini-ai-1c portable)
- MCP через HTTP к серверу
- BSL LS через WebSocket к серверу
- Конфиг с сервера + локальные переопределения
- Авто-обновление с сервера
- EditorBridge — единственное локальное (named pipe)

## Структура репозитория

```
ai-1c-server/
├── Cargo.toml
├── AGENTS.md
├── .gitignore
├── .opencode.json
├── src/
│   ├── main.rs              # CLI args, init
│   ├── server.rs            # Axum HTTP server
│   ├── api/
│   │   ├── mod.rs
│   │   ├── config.rs        # GET /api/client/config
│   │   ├── mcp.rs           # POST /api/mcp/:id
│   │   ├── admin/           # CRUD для админ-панели
│   │   │   ├── mod.rs
│   │   │   ├── mcp_servers.rs
│   │   │   ├── skills.rs
│   │   │   ├── configs.rs
│   │   │   └── clients.rs
│   │   ├── updater.rs       # GET /api/updater/check
│   │   └── skills.rs        # GET /api/skills
│   ├── mcp/
│   │   ├── mod.rs
│   │   ├── manager.rs       # MCP subprocess lifecycle
│   │   └── protocol.rs      # JSON-RPC types
│   ├── db/
│   │   ├── mod.rs
│   │   ├── migrations.rs
│   │   └── models.rs
│   ├── watcher/
│   │   ├── mod.rs
│   │   └── indexer.rs
│   ├── updater/
│   │   ├── mod.rs
│   │   └── bundler.rs
│   ├── auth/
│   │   └── mod.rs
│   └── web/
│       └── (embedded admin dashboard build)
├── migrations/
│   └── 001_initial.sql
├── admin-ui/                 # React SPA source
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/              # API client
│       ├── pages/
│       │   ├── Dashboard.tsx
│       │   ├── McpServers.tsx
│       │   ├── Skills.tsx
│       │   ├── Configs.tsx
│       │   ├── Clients.tsx
│       │   └── Logs.tsx
│       └── components/
└── scripts/
    ├── build-linux.sh
    ├── build-windows.ps1
    └── dev.sh
```

## Database schema (SQLite)

```sql
CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    server_type TEXT NOT NULL,      -- 'search' | 'help' | 'naparnik' | 'metadata' | 'bsl-ls' | 'custom'
    transport TEXT NOT NULL DEFAULT 'stdio',
    command TEXT,                    -- для stdio серверов
    args TEXT,                       -- JSON array
    env TEXT,                        -- JSON object (env vars)
    url TEXT,                        -- для HTTP серверов
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT,                     -- JSON: server-specific config
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    server_id TEXT REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    tool_schema TEXT NOT NULL,
    category TEXT,
    version TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE config_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    last_indexed TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE client_versions (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    platform TEXT NOT NULL,
    url TEXT NOT NULL,
    checksum TEXT NOT NULL,
    changelog TEXT,
    required INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT,
    version TEXT,
    last_seen TEXT,
    config_override TEXT
);

CREATE TABLE server_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    user TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    details TEXT
);
```

## API Endpoints

### Client-facing
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/client/config` | Полная конфигурация для клиента |
| POST | `/api/mcp/{server_id}` | JSON-RPC вызов MCP-сервера |
| GET | `/api/skills` | Список доступных скиллов |
| GET | `/api/updater/check?version=X` | Проверка обновлений |
| GET | `/api/updater/download/{id}` | Скачать клиентскую сборку |

### Admin (from dashboard)
| Method | Path | Description |
|--------|------|-------------|
| GET/POST/PUT/DELETE | `/api/admin/mcp-servers` | CRUD MCP-серверов |
| GET/POST/PUT/DELETE | `/api/admin/skills` | CRUD скиллов |
| GET/POST/PUT/DELETE | `/api/admin/config-profiles` | Управление профилями 1С |
| GET/POST/DELETE | `/api/admin/client-versions` | Управление версиями клиента |
| GET | `/api/admin/clients` | Список клиентов |
| GET | `/api/admin/logs` | Логи сервера |
| GET | `/api/admin/status` | Статус всех MCP-серверов |
| POST | `/api/admin/reindex` | Принудительная реиндексация |

## План реализации

| Этап | Описание | Дней |
|------|----------|------|
| 1 | Каркас: axum + SQLite + CLI args + система сборки | 2 |
| 2 | MCP Gateway: subprocess manager, HTTP→stdio proxy, health checks | 3 |
| 3 | Config API: endpoint для клиентов, merge-стратегия | 1 |
| 4 | File Watcher + интеграция mcp-1c-search | 2 |
| 5 | Skills Registry: CRUD + API | 2 |
| 6 | Admin Dashboard: React SPA + сборка в бинарник | 4 |
| 7 | Updater: версионирование, авто-обновление клиента | 2 |
| 8 | Клиент: portable mode, enterprise config, auto-update | 3 |
| 9 | BSL LS: серверный запуск + WebSocket | 1 |
| 10 | Аутентификация: токены | 1 |
| 11 | Linux systemd service + Windows service + документация | 2 |

**Всего: ~23 дня**

## Зависимости Rust

```toml
[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
tower-http = { version = "0.6", features = ["cors", "fs"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rusqlite = { version = "0.32", features = ["bundled"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
rust-embed = "8"
notify = "7"
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
clap = { version = "4", features = ["derive"] }
reqwest = { version = "0.12", features = ["json"] }
jsonwebtoken = "9"
sha2 = "0.10"
```

## CLI

```bash
# Запуск
mini-ai-1c-server \
  --data-dir /data/mini-ai-1c \
  --http-port 9224 \
  --admin-dir /path/to/admin-dashboard/build

# Режимы
mini-ai-1c-server --help
mini-ai-1c-server --version
mini-ai-1c-server migrate                     # Применить миграции БД
```

## Клиент (mini-ai-1c) — необходимые изменения

1. CLI-флаг `--server URL` — включает enterprise mode
2. `SettingsContext`: при наличии `--server` — GET `/api/client/config`, глубокий merge с локальными настройками
3. `MCP`: все серверы переключаются на `transport: "http"` с адресом сервера
4. BSL LS: `settings.bsl_server.remote_url = "ws://server:8025/lsp"`
5. Новый `UpdaterContext`: проверка обновлений при старте, скачивание, применение
6. Portable сборка: `npm run build:portable` — ZIP вместо MSI
