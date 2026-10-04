# Установка и развёртывание на VPS

## 1. Создание VPS

**Рекомендуемая конфигурация:**
- OS: Ubuntu 22.04 или 24.04
- RAM: 4-8 GB
- CPU: 2-4 ядра
- Диск: SSD от 20 GB
- Провайдеры: Timeweb, Selectel, Hetzner

## 2. Базовая настройка сервера

```bash
# Подключиться
ssh root@<vps-ip>

# Обновить пакеты
apt update && apt upgrade -y

# Установить базовые зависимости
apt install -y curl git build-essential pkg-config libssl-dev unzip

# Установить Node.js 22.x
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Установить Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

# Установить tmux
apt install -y tmux
```

**Проверка:**
```bash
node --version    # >= 22
npm --version     # >= 10
rustc --version   # >= 1.80
cargo --version
```

## 3. Клонирование и сборка проекта

```bash
git clone https://github.com/vitebc/ai-1c-server.git
cd ai-1c-server

# Сборка (admin-ui + Rust)
./scripts/build-linux.sh
```

## 4. Запуск сервера

Prod живёт в `/home/test/.config/ai-1c-server/adminka` (вне git): там
бинарник, `admin-ui/dist`, `migrations/`, своя `data/` и скрипты запуска.
Выкатка — `./scripts/deploy.sh` из репо (build + копирование + рестарт).

```bash
# Первый запуск — инициализация БД
/home/test/.config/ai-1c-server/adminka/start.sh

# Проверка
curl http://localhost:9224/health
# → OK

# Статус / остановка
/home/test/.config/ai-1c-server/adminka/status.sh
/home/test/.config/ai-1c-server/adminka/stop.sh
```

**Проверить извне:**
```bash
curl http://<vps-ip>:9224/health
```
Если не отвечает — открыть порт:
```bash
ufw allow 9224/tcp
# или на уровне провайдера
```

## 4.1. Служба systemd (автозапуск после перезагрузки)

Ручной запуск через `start.sh` переживает обрыв SSH, но не переживает
перезагрузку сервера. Для постоянной работы — служба:

```bash
# Сначала остановить ручной инстанс (служба откажется стартовать поверх него)
./scripts/stop.sh

# Установка + автозапуск (под текущим пользователем, порт 9224, data в ./data)
sudo ./scripts/install-service.sh

# Другие варианты:
sudo ./scripts/install-service.sh --user test --port 9224 --data-dir /home/test/project/ai-1c-server/data

# Статус / логи / перезапуск
./scripts/service-status.sh
./scripts/service-logs.sh          # follow
./scripts/service-logs.sh -n 200   # последние 200 строк
sudo systemctl restart ai-1c-server

# Настройки службы (порт, data-dir) — /etc/ai-1c-server/env, затем restart
# Удаление службы (данные БД не трогает):
sudo ./scripts/uninstall-service.sh
```

Порядок при обновлении кода:
```bash
git pull && ./scripts/deploy.sh     # build + копирование в adminka/ + stop/start
# если работает служба вместо ручного инстанса:
sudo systemctl restart ai-1c-server # после update.sh
```

## 5. OpenCode на VPS

```bash
# Установить OpenCode
npm install -g @opencode/cli

# Создать tmux сессию для разработки
tmux new -s opencode
cd ~/project/ai-1c-server

# Запустить OpenCode
opencode

# Ctrl+B, D — отключиться (сессия остаётся)
# tmux attach -t opencode — вернуться
```

Если нужен веб-терминал (без SSH-клиента):
```bash
apt install -y docker.io
docker run -d --restart always -p 7681:7681 tsl0922/ttyd tmux new -A -s dev
# → http://<vps-ip>:7681
```

## 6. Подключение MCP к OpenCode и другим агентам

Единая точка входа — агрегированный MCP (все включённые серверы, тулзы с
префиксом `<server>__<tool>`):

```bash
# Скопировать готовый конфиг (форматы: opencode, opencode-legacy, claude, cursor)
curl -s "http://<vps-ip>:9224/api/admin/mcp-servers/export?format=opencode"
```

Или вручную. Для **OpenCode** (sst, `opencode.json`):

```json
{
  "mcp": {
    "ai-1c-all": {
      "type": "remote",
      "url": "http://<vps-ip>:9224/api/mcp-aggregated/mcp",
      "headers": {
        "Authorization": "Bearer <api-token>"
      },
      "enabled": true
    }
  }
}
```

API-токен генерируется при первом старте (см. лог `server.log`:
`Generated new API token`) и хранится в `server_settings`.
По умолчанию авторизация **включена**: без логина MCP-шлюз отдаёт 401,
админка показывает экран входа. Выключать (`Auth OFF` /
`auth_required=0`) — только для полностью изолированного контура.
Включить: Dashboard → API Access → Auth ON (или
`PUT /api/admin/settings {"key":"auth_required","value":"1"}`).

Тумблер влияет **только** на MCP-шлюз (`/api/mcp*`,
`/api/mcp-aggregated/*`, `/api/mcp-skills/*`). Админка (`/api/admin/*`)
всегда требует логин/пароль; legacy machine-токен там → 401.

Вход людей — по логину/паролю (`POST /api/admin/auth/login` → JWT на
12ч, с `remember: true` — 7 дней). Машинный API-токен — только для
MCP-клиентов (заголовок `Authorization`), в админке входа по нему нет.
При первом старте создаётся `admin` со случайным паролем
(лог `server.log`, один раз). Защита от перебора: >5 неверных login
с IP за 10 мин → 429 на 5 мин.

Для **Claude Code**: `claude mcp add --transport http ai-1c-all http://<vps-ip>:9224/api/mcp-aggregated/mcp`
Для **Cursor** (`mcp.json`): `{ "mcpServers": { "ai-1c-all": { "url": "http://<vps-ip>:9224/api/mcp-aggregated/mcp" } } }`

Per-server URL: `http://<vps-ip>:9224/api/mcp/<id|name>/mcp`
(GET — SSE для legacy-клиентов, POST — Streamable HTTP).
Кнопки копирования всех форматов — в Admin UI на странице MCP Servers.

Инвентарь тулзов для скриптов (зона шлюза, достаточно API-токена):

```bash
curl -s http://<vps-ip>:9224/api/mcp-aggregated/tools -H "$T" | \
  python3 -c "import json,sys; [print(t['full_name']) for t in json.load(sys.stdin)['tools']]"
```

Hot-reload: добавление/изменение/удаление сервера через API или Admin UI
сразу (пере)запускает сессию — ребут сервера не нужен. Вручную:
`POST /api/admin/mcp-servers/{id}/restart`.

Транспорты MCP-сервера: `stdio` (свой subprocess, JSON-RPC через stdin/stdout) и
`http`/`sse` (входящий Streamable HTTP-клиент к удалённому серверу; поле `env`
используется как HTTP-заголовки). Оба управляются одинаково.

## 6.1. Пользователи и роли

Страница **Users** (секция `users`, admin-only для изменений):

| Роль | Секции | Право записи |
|---|---|---|
| `admin` | все 19 | везде; не настраивается |
| `operator` | все, кроме `users`, `auth-manage` | в рамках своих секций |
| `prompter` | как `viewer` | только агенты/скиллы/паттерны (файлы промптов) |
| `viewer` | 12 read-only секций | только свой пароль |

- **Матрица ролей** (только admin): сетка «роль × раздел» меняет дефолты ролей
  целиком; хранится в `server_settings.role_sections`.
- **Per-user** чекбоксы — только ВЫЧИТАНИЕ секций у конкретного юзера; выдать
  раздел вне роли можно лишь через матрицу ролей.
- Ограничения: свою роль и `enabled` менять нельзя; свои секции — нельзя никому,
  кроме admin; нельзя удалить себя, отключить/понизить последнего admin.
- Админ-аккаунты скрыты от не-админов (в списке и по 404) — чтобы имена
  админов не утекали.

## 6.2. AI Agent Studio и backend 1c-ai-agent

Страница **Agent Studio** (секции `agent-studio` + подсекции
`agent-agents|agent-skills|agent-patterns|agent-backend|env`):

- **Агенты/Скиллы/Паттерны** — CRUD файлов проекта 1c-ai-agent
  (`backend/agents/<имя>/AGENT.md`, `backend/skills/<имя>/SKILL.md`,
  `backend/patterns/<имя>.md`). Корень — настройка `agent_project_root`.
  Бэкенд перечитывает файлы на каждый запрос, рестарт не нужен; у скилла
  зелёная точка = бэкенд видит скилл в live-списке, жёлтая = нет.
- **Провайдеры моделей** (отдельная страница **Models**, секция `models`):
  `name`, `base_url`, `api_key` (не возвращается), список моделей.
  Кнопка probe делает живой `GET {base_url}/models` — модели подставляются
  чекбоксами, модель можно ввести вручную.
- **Backend** — управление docker-compose сервисами проекта
  (`postgres`, `backend`, `tei`, `mcp-proxy`; профили `rag`, `onec`),
  просмотр логов с фильтром `grep` и переключателем таймстемпов, редактор
  `.env` по allowlist (секреты маскируются), live-состояние бэкенда.
- В форме агента: вкладки (Основное / Инструменты / Скиллы и модель),
  Tools и MCP в две колонки с групповым выбором по `server__tool`,
  поиск по имени/описанию, мультивыбор MCP из живого реестра.

## 7. Импорт скилов (серверных)

```bash
# Импорт из .opencode/skills/ (если есть локально)
curl -X POST http://localhost:9224/api/admin/skills/import \
  -H "Content-Type: application/json" \
  -d '{"dir":"/home/clawa/.opencode/skills"}'

# Или через веб-интерфейс:
# http://<vps-ip>:9224/skills → Import
```

## 8. Сессии разработки (tmux)

```bash
tmux new -s server       # Сервер ai-1c-server
tmux new -s code         # OpenCode / разработка
tmux new -s build        # Сборка

# Просмотр сессий
tmux ls

# Подключение к сессии
tmux attach -t code

# Убить сессию
tmux kill-session -t build
```

## 9. Обновление

```bash
cd ~/project/ai-1c-server

# Всё сразу: pull + build + stop/start
./scripts/update.sh

# Если сервер запущен как systemd-служба — после update.sh:
sudo systemctl restart ai-1c-server
```

Порядок сборки важен: `build-linux.sh` сначала собирает `admin-ui`
(`npm install && npm run build`), затем `cargo build --release --target
x86_64-unknown-linux-gnu`. Бандл админки вшивается в бинарник через
`rust-embed`, поэтому без `npm run build` UI будет старой версии.

> ⚠️ `npm run build` не падает на ошибках TypeScript. Если в выводе есть
> `error TS...` — правку не коммитить: в прод уедет сломанный бандл.

Проверка, что новая версия реально отдаётся:

```bash
curl -s http://localhost:9224/ | grep -o 'index-[^"]*\.js'   # хеш бандла изменился?
```

## 10. Полезные ссылки

| Ресурс | Адрес |
|--------|-------|
| **Admin Dashboard** | `http://<vps-ip>:9224/` |
| **Health Check** | `http://<vps-ip>:9224/health` |
| **Агрегированный MCP** | `http://<vps-ip>:9224/api/mcp-aggregated/mcp` |
| **Инвентарь тулзов (JSON)** | `http://<vps-ip>:9224/api/mcp-aggregated/tools` |
| **MCP Skills API** | `http://<vps-ip>:9224/api/mcp-skills/rpc` |
| **Skills Export** | `http://<vps-ip>:9224/api/admin/skills/export` |
| **GitHub** | `https://github.com/vitebc/ai-1c-server` |

Полный справочник по эндпоинтам — в `API.md`.

## 11. Структура проекта

```
ai-1c-server/
├── src/                    # Rust бэкенд
│   ├── main.rs             # Точка входа, CLI (clap)
│   ├── api/                # Axum route handlers
│   │   ├── admin/          # CRUD, RBAC-секции, agent-files, agent_backend
│   │   ├── mcp_http.rs     # MCP HTTP/SSE шлюз (агрегатор + per-server)
│   │   └── mcp_skills.rs   # Серверные скиллы как MCP
│   ├── db/                 # SQLite (rusqlite) + миграции
│   ├── mcp/                # MCP Gateway (stdio|http сессии), BSL LS, скиллы
│   ├── auth/               # argon2 + JWT + RBAC
│   ├── log_buffer.rs       # Кольцевой буфер логов
│   ├── watcher/            # Заглушка (fsnotify-реиндекс)
│   ├── updater/            # Заглушка (клиентские сборки)
│   └── web/                # Embedded admin-ui/dist
├── admin-ui/               # React 19 + Vite + Tailwind v4 SPA
│   └── src/
│       ├── pages/          # Dashboard, McpServers, ModelProviders, AgentStudio,
│       │                   # Skills, BslLs, Configs, ClientVersions, Clients,
│       │                   # Logs, Users
│       ├── components/     # ui.tsx (Modal/Table/Field/Segmented…), FileBrowser
│       ├── api/client.ts   # Типизированный API-клиент
│       ├── i18n.ts         # Русские строки
│       └── types.ts
├── scripts/                # bash-скрипты
│   ├── start.sh            # Запуск сервера (с pre-flight проверками)
│   ├── stop.sh             # Остановка
│   ├── restart.sh          # Перезапуск
│   ├── status.sh           # Проверка статуса
│   ├── update.sh           # pull + build + stop/start
│   ├── build-linux.sh      # admin-ui → cargo
│   ├── build-windows.ps1   # То же под Windows
│   └── install-service.sh  # systemd (+ systemd/ai-1c-server.service)
├── migrations/             # SQL миграции 001…005
├── data/                   # Runtime (.gitignore)
│   ├── db.sqlite           # База данных
│   ├── skills/             # Серверные скиллы на диске
│   └── bsl-language-server.jar
├── API.md                  # Справочник HTTP API
├── SETUP.md                # Этот файл
└── AGENTS.md               # Состояние проекта и правила для агента
```

## 12. Переменные окружения и флаги

| Переменная | Назначение | По умолчанию |
|-----------|-----------|-------------|
| `DATA_DIR` | Путь к runtime данным (передаётся как `--data-dir`) | `$REPO/data` |
| `PORT` | HTTP порт (передаётся как `--http-port`) | `9224` |

Флаги бинарника: `--data-dir` (`/data/mini-ai-1c`), `--http-port` (`9224`),
`--admin-dir` (каталог со статикой админки, если не вшит в бинарник),
подкоманда `migrate` (применить миграции и выйти; `start.sh` зовёт её
автоматически перед запуском).

```bash
# Пример запуска с кастомными параметрами
DATA_DIR=/mnt/data PORT=8080 ./scripts/start.sh
```

Ключевые настройки в БД (`server_settings`, меняются через админку
или `PUT /api/admin/settings {"key":"...","value":"..."}`):
`auth_required` (гейт MCP-шлюза), `api_token` (legacy machine-токен),
`jwt_secret`, `agent_project_root`, `role_sections`, `search_binary`.
