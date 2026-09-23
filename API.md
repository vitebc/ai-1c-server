# AI 1C Server — API

Базовый URL: `http://<host>:9224`. Все ответы — JSON.

## Авторизация

| Зона | Правило |
|---|---|
| `GET /health`, админка (статика) | открыто |
| `/api/admin/*` | **всегда** нужен `Authorization: Bearer <JWT>` (логин/пароль). Machine-токен здесь не принимается → 401 |
| MCP-шлюз (`/api/mcp*`, `/api/mcp-aggregated/*`, `/api/mcp-skills/*`) | при `auth_required=1` (по умолчанию) нужен `Bearer <JWT или API-токен>`; при `auth_required=0` — открыто для LAN |

- `auth_required` переключает **только** MCP-шлюз (карточка «MCP Token Auth» на Dashboard). Админка требует логин всегда.
- Роли: `admin` (всё), `operator` (всё кроме Users/токена), `viewer` (только чтение; любой не-GET кроме смены своего пароля → 403).
- Нет прав на секцию → 403. Логин: >5 неудач с IP за 10 мин → 429 на 5 мин.

```bash
JWT=$(curl -s -X POST http://localhost:9224/api/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"...","remember":true}' | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
H="Authorization: Bearer $JWT"   # далее -H "$H"
```

## MCP-шлюз (для машинных клиентов)

Единая точка: `POST /api/mcp-aggregated/mcp` (JSON-RPC: `initialize`, `tools/list`, `tools/call`; тулзы префиксуются `server__tool`). `GET` на том же пути — SSE для legacy-клиентов. Отдельный сервер: `/api/mcp/{id}/mcp`. Пресеты под opencode/Claude/Cursor — `GET /api/admin/mcp-servers/export?format=opencode|opencode-legacy|claude|cursor` (токен подставляется автоматически).

```bash
curl -s -X POST http://localhost:9224/api/mcp-aggregated/mcp -H "$H" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Инвентарь тулзов для скриптов (REST, зона шлюза — работает с API-токеном)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/mcp-aggregated/tools` | все тулзы всех включённых серверов: `{tools: [{server, server_id, name, full_name, description, inputSchema}], errors: [...]}` (`full_name` — имя для вызова через агрегатор: `server__tool`) |
| GET | `/api/mcp/{id\|name}/tools` | тулзы одного сервера: `{id, name, tools[]}` (404 нет/выключен, 502 не running) |

```bash
T="Authorization: Bearer <API-токен>"
curl -s http://localhost:9224/api/mcp-aggregated/tools -H "$T" | python3 -c \
  "import json,sys; [print(t['full_name']) for t in json.load(sys.stdin)['tools']]"
# вызвать найденный тул через агрегатор:
curl -s -X POST http://localhost:9224/api/mcp-aggregated/mcp -H "$T" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"1c_jvv__list_infobases","arguments":{}}}'

## Admin API (`/api/admin`, везде нужен JWT)

### Auth / Users
| Метод | Путь | Тело / ответ |
|---|---|---|
| POST | `/auth/login` | `{username, password, remember?}` → `{token, username, role, sections}` (публичный) |
| GET | `/auth/me` | `{username, role, sections}` |
| POST | `/auth/password` | `{old_password, new_password}` (свой пароль) |
| GET | `/auth/token` | `{token, auth_required}` (секция `auth-manage`) |
| POST | `/auth/rotate` | → `{token}`, старый умирает сразу (подтверждать в UI) |
| GET/POST | `/users` | список / создать `{username, password, role}` |
| PUT/DELETE | `/users/{id}` | `{role?, enabled?, sections?}` (переопределения `{"sec": true/false}`) |
| POST | `/users/{id}/reset-password` | → `{username, password}` (сгенерированный) |
| POST | `/users/{id}/password` | `{password}` (задать вручную) |

### MCP-серверы
| Метод | Путь | Описание |
|---|---|---|
| GET/POST | `/mcp-servers` | список / создать (`name`, `server_type`, `transport`: `stdio\|http\|sse`, `command`, `args` JSON-массив, `env` JSON-объект — для http это HTTP-заголовки, `url` для http/sse, `enabled`) |
| GET/PUT/DELETE | `/mcp-servers/{id}` | CRUD (id или name) |
| POST | `/mcp-servers/{id}/restart` | hot-reload → `{id, running}` |
| GET | `/mcp-servers/{id}/tools` | живой `tools/list` → `{id, tools[]}` (404 нет, 502 не running) |
| GET | `/mcp-servers/{id}/stats` | вывод тулзы `stats` (индекс поисковиков) |
| POST | `/mcp-servers/{id}/reindex` | полный реиндекс фоном → `{job_id}` |
| GET | `/mcp-servers/reindex/job/{job_id}` | прогресс `{state: running\|done\|error, progress, message, ...}` |
| GET | `/mcp-servers/export` | `?format=&base=&token=&notoken=` |

### Прочее
| Метод | Путь | Описание |
|---|---|---|
| GET | `/status` | `[{id, name, status}]` — running/stopped |
| GET/PUT | `/settings` | все настройки / `{key, value}` (`auth_required`, `agent_project_root`, ...) |
| GET | `/logs?level=&limit=&search=&target=` | кольцевой буфер; `target` — префикс (`ai_1c_server::mcp` покрывает `::session`...) |
| GET | `/logs/targets` | distinct `ai_1c_server::*` таргеты |
| POST | `/logs/clear` | очистить |
| GET | `/fs/browse?path=&show_hidden=` | файловый браузер (выбор бинарников/путей) |
| CRUD | `/skills`, `/skills/{id}` + `/skills/import`, `/skills/upload`, `/skills/export` | серверные скиллы |
| CRUD | `/config-profiles`, `/config-profiles/{id}` | профили конфигов 1С (+ автосинк `search-*` строк) |
| CRUD | `/client-versions`, `/client-versions/{id}`; GET `/clients` | версии и подключённые клиенты |
| POST | `/reindex` | заглушка |

### BSL Language Server
`GET /bsl-ls` (статус), `POST /bsl-ls/config|/restart|/stop|/install-java`, `GET /bsl-ls/logs`, `POST /bsl-ls/logs/clear`, `GET /bsl-ls/versions`, `POST /bsl-ls/download/{version}`.

### AI Agent Studio (проект 1c-ai-agent)
- `GET /agent-files` — overview (фильтруется по подсекциям), `GET /agent-files/tools` — статический список тулзов.
- CRUD агентов/скиллов/паттернов: `POST /agent-files/agents|skills|patterns`, `PUT/DELETE /agent-files/agents/{name}` и т.д. Подсекции: `agent-agents`, `agent-skills`, `agent-patterns`.
- Backend: `GET /agent-backend/status`, `POST /agent-backend/up|stop|restart` (`{services[], profiles[]}`), `GET /agent-backend/logs?service=&tail=`, `GET/PUT /agent-backend/env` (секция `env`), live: `GET /agent-backend/live/agents|skills[?agent=]|tools` (достаточно любой файловой подсекции).

## Коды ошибок
`401` — нет/невалиден Bearer (на админке legacy-токен тоже 401), `403` — нет секции или viewer пишет, `404` — нет объекта (и любой неизвестный `/api/*`), `429` — лок логина, `502` — MCP-сервер не running.
