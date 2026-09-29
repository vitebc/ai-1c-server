# AI 1C Server — API

Базовый URL: `http://<host>:9224`. Все ответы — JSON, кроме статики админки.

Полный список роутов собирается в `src/api/admin/mod.rs` (`/api/admin/*`)
и `src/api/mod.rs` (корень + MCP-шлюз).

## Авторизация

| Зона | Правило |
|---|---|
| `GET /health`, статика админки (`/`, `/assets/*`) | открыто |
| `/api/admin/*` | **всегда** `Authorization: Bearer <JWT>` (логин/пароль). Machine-токен здесь не принимается → 401 |
| MCP-шлюз (`/api/mcp*`, `/api/mcp-aggregated/*`, `/api/mcp-skills/*`) | при `auth_required=1` (по умолчанию) нужен `Bearer <JWT или API-токен>`; при `auth_required=0` — открыто для LAN |

- `auth_required` переключает **только** MCP-шлюз (карточка «API Access» на Dashboard). Админка требует логин всегда.
- Любой неизвестный `/api/*` → 404 (`api_404` в `src/api/mod.rs`).

### Роли и секции

| Роль | Секции по умолчанию | Право записи |
|---|---|---|
| `admin` | все 19 (не настраивается) | везде |
| `operator` | все, кроме `users`, `auth-manage` | везде в рамках секций |
| `prompter` | как `viewer` | только `agent-files/agents`, `agent-files/skills`, `agent-files/patterns` |
| `viewer` | 12 read-only секций | только свой пароль |

- Секции (19): `dashboard, mcp-servers, models, agent-studio, agent-agents,
  agent-skills, agent-patterns, agent-backend, skills, bsl-ls, configs,
  client-versions, clients, logs, settings, fs, env, users, auth-manage`.
- Дефолты ролей переопределяются админом: `server_settings.role_sections`
  → `GET/PUT /api/admin/users/roles`. Ключи — только `operator|viewer|prompter`.
- Per-user `sections` — **только вычитание** из секций своей роли. Чтобы выдать
  секцию вне роли, менять матрицу ролей (admin-only).
- Псевдо-секции в `section_for`: `__self` (`auth/me`, `auth/password` — любой
  залогиненный), `__agent_files_any` (обзор/тулзы/live-бэкенд/опции
  провайдеров — достаточно любой из `agent-agents|agent-skills|agent-patterns|agent-backend`).
- Нет секции → 403. Логин: >5 неудач с IP за 10 мин → 429 на 5 мин.

```bash
JWT=$(curl -s -X POST http://localhost:9224/api/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"...","remember":true}' | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
H="Authorization: Bearer $JWT"   # далее -H "$H"
```

## MCP-шлюз (для машинных клиентов)

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/mcp-aggregated/mcp` | JSON-RPC единой точкой: `initialize`, `tools/list`, `tools/call`; имена тулзов `server__tool` |
| GET | `/api/mcp-aggregated/mcp` | тот же endpoint через SSE (legacy-клиенты) |
| POST/GET | `/api/mcp/{id\|name}/mcp` | один сервер: POST — Streamable HTTP, GET — SSE |
| POST | `/api/mcp/{server_id}` | legacy JSON-RPC прокси одного сервера |
| GET/POST | `/api/mcp-skills/rpc` | серверные скиллы как MCP |

```bash
curl -s -X POST http://localhost:9224/api/mcp-aggregated/mcp -H "$H" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Инвентарь MCP для скриптов (REST, зона шлюза — API-токен или открыто, если токен-аутентификация выключена)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/mcp` | список включённых MCP-серверов: `{servers: [{id, name}]}` |
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
```

## Admin API (`/api/admin`, везде нужен JWT)

### Auth / Users

| Метод | Путь | Тело / ответ |
|---|---|---|
| POST | `/auth/login` | `{username, password, remember?}` → `{token, username, role, sections}` (публичный, rate-limit) |
| GET | `/auth/me` | `{username, role, sections, system?}` |
| POST | `/auth/password` | `{old_password, new_password}` (свой пароль, секция `__self`) |
| GET | `/auth/token` | `{token, auth_required}` (секция `auth-manage`) |
| POST | `/auth/rotate` | → `{token}`, старый умирает сразу (подтверждать в UI) |
| GET/POST | `/users` | список / создать `{username, password, role}`. Админы скрыты от не-админов (404). Роль `admin` — только админ. Роли: `admin/operator/viewer/prompter` |
| GET/PUT | `/users/roles` | матрица дефолтных секций `{roles: {operator, viewer, prompter}}`; PUT — **только админ** (403), пишет `server_settings.role_sections` |
| PUT/DELETE | `/users/{id}` | `{role?, enabled?, sections?}`; DELETE — **только админ** |
| POST | `/users/{id}/reset-password` | → `{username, password}` (сгенерированный; админы скрыты от не-админов) |
| POST | `/users/{id}/password` | `{password}` (задать вручную) |

Ограничения саморедактирования (`src/api/admin/users.rs`):

- свою роль / `enabled=false` — 400 «cannot change own role or disable self»;
- свои `sections` — 400 «cannot change own rights», **кроме** admin-ов;
- `DELETE` себя — 400 «cannot delete yourself»;
- нельзя отключить/понизить **последнего** включённого admin — 400;
- не-админ: цель-админ → 404, выдача роли `admin` → 403;
- `sections: null` — сброс к дефолтам роли.

### MCP-серверы

| Метод | Путь | Описание |
|---|---|---|
| GET/POST | `/mcp-servers` | список / создать (`name`, `server_type`, `transport`: `stdio\|http\|sse`, `command`, `args` JSON-массив, `env` JSON-объект — для http это HTTP-заголовки, `url` для http/sse, `enabled`) |
| GET/PUT/DELETE | `/mcp-servers/{id}` | CRUD (id или name); hot-reload сессии без ребута |
| POST | `/mcp-servers/{id}/restart` | hot-reload → `{id, running}` |
| GET | `/mcp-servers/{id}/tools` | живой `tools/list` → `{id, tools[]}` (404 нет, 502 не running) |
| GET | `/mcp-servers/{id}/stats` | вывод тулзы `stats` (индекс поисковиков) |
| POST | `/mcp-servers/{id}/reindex` | полный реиндекс фоном → `{job_id}` |
| GET | `/mcp-servers/reindex/job/{job_id}` | прогресс `{state: running\|done\|error, progress, message, ...}` |
| GET | `/mcp-servers/export` | `?format=opencode\|opencode-legacy\|claude\|cursor&base=&token=&notoken=` (токен подставляется автоматически) |

Транспорты: `stdio` — свой subprocess (JSON-RPC через stdin/stdout),
`http`/`sse` — входящий Streamable HTTP-клиент к удалённому серверу
(`src/mcp/http_session.rs`).

### Прочее

| Метод | Путь | Описание |
|---|---|---|
| GET | `/status` | `[{id, name, status}]` — running/stopped |
| GET | `/dashboard` | сводка (секция `dashboard`, видна всем): `{servers, skills, configs, clients, mcp[], bsl}` |
| GET/PUT | `/settings` | все настройки / `{key, value}` (`auth_required`, `api_token`, `agent_project_root`, `role_sections`, `search_binary`, ...) |
| GET | `/logs?level=&limit=&search=&target=` | кольцевой буфер (1000 записей); `target` — префикс таргета (`ai_1c_server::mcp` покрывает `::session`) |
| GET | `/logs/targets` | distinct `ai_1c_server::*` таргеты |
| POST | `/logs/clear` | очистить |
| GET | `/fs/browse?path=&show_hidden=` | read-only файловый браузер (выбор бинарников/путей), секция `fs` |
| CRUD | `/skills`, `/skills/{id}` + `/skills/import`, `/skills/upload`, `/skills/export` | серверные скиллы (отдельные от агентских) |
| CRUD | `/config-profiles`, `/config-profiles/{id}` | профили конфигов 1С (+ автосинк `search-*` строк) |
| CRUD | `/client-versions`, `/client-versions/{id}`; GET `/clients` | версии и подключённые клиенты |
| POST | `/reindex` | заглушка (`"Reindex triggered (stub)"`) |

### Провайдеры моделей

CRUD: `GET/POST /model-providers`, `GET/PUT/DELETE /model-providers/{id}` — `{name, base_url (http...), api_key?, models[] | "a, b", enabled?, is_default?}`. Секция `models` (operator/prompter/viewer включены). Ключ никогда не возвращается (`api_key_set: bool`; пустой ключ в PUT = оставить).

- `POST /model-providers/{id}/probe` → `{ok, models[], error?}` — `GET {base_url}/models` со stored-ключом.
- `POST /model-providers/probe` `{base_url, api_key?}` — тот же опрос для несохранённой формы (живой мультивыбор моделей, debounce 800 мс в UI).
- `GET /model-providers/options` → `{providers: [{name, default_model, models, is_default}]}` для пикера модели/провайдера у агента. Секция `__agent_files_any` — виден любой файловой подсекцией.

### BSL Language Server

`GET /bsl-ls` (статус: config/pid/status), `POST /bsl-ls/config|/restart|/stop|/install-java`, `GET /bsl-ls/logs`, `POST /bsl-ls/logs/clear`, `GET /bsl-ls/versions`, `POST /bsl-ls/download/{version}`.

### AI Agent Studio (проект 1c-ai-agent)

Корень проекта — `server_settings(agent_project_root)` (по умолчанию авто-поиск
рядом с сервером), файлы: `backend/agents/<name>/AGENT.md`,
`backend/skills/<name>/SKILL.md`, `backend/patterns/<name>.md`.

| Метод | Путь | Описание |
|---|---|---|
| GET | `/agent-files` | overview: `{root, root_exists, agents[], skills[], patterns[]}` — фильтруется по подсекциям |
| GET | `/agent-files/tools` | статический список известных тулзов (строки), для подсказок в редакторе |
| GET | `/agent-files/mcp-options` | `{servers: [{name, running}]}` включённых MCP для мультиселекта редактора (без команд/URL, секция `__agent_files_any`) |
| POST | `/agent-files/agents\|skills\|patterns` | создать (имя `^[a-z0-9-]+$`, max 64) |
| PUT/DELETE | `/agent-files/agents/{name}`, `.../skills/{name}`, `.../patterns/{name}` | изменить / удалить (переименование = перемещение папки) |

- Подсекции: `agent-agents`, `agent-skills`, `agent-patterns`.
- Тела: агент `{name, title, description, tools[], skills[], mcp[], model?, provider?, body}`; скилл `{name, description, tools[], body}`; паттерн `{name, description, body}`.
- Канонический порядок frontmatter агента: `name, title, description, tools, skills, mcp, model, provider`. `mcp` — список (`mcp: [a, b]`), совместим с `Agent.mcp_servers` бэкенда; `provider` бэкендом игнорируется.
- Бэкенд перечитывает файлы на каждый запрос — рестарт не нужен. Live-видимость проверяется через `/agent-backend/live/*`.

### Agent Backend (docker compose)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/agent-backend/status` | `{services[], profiles[], backend_url, project_root, ...}` (секция `agent-backend`) |
| POST | `/agent-backend/up` | `{services[]?, profiles[]?}` — сервисы из allowlist `postgres, backend, tei, mcp-proxy`, профили `rag, onec`; прочее → 400 |
| POST | `/agent-backend/stop`, `/agent-backend/restart` | те же тела |
| GET | `/agent-backend/logs?service=&tail=&timestamps=&grep=` | compose-логи; `grep` — регистронезависимый фильтр подстроки |
| GET/PUT | `/agent-backend/env` | `.env` по allowlist (~30 ключей), секреты маскируются на чтении; запись — секция `env` |
| GET | `/agent-backend/live/agents\|skills[?agent=]\|tools` | живое состояние бэкенда: `{reachable, data}` / `{reachable, error}`; секция `__agent_files_any` |

## Коды ошибок

| Код | Когда |
|---|---|
| 400 | валидация (имя, роль, JSON в `args`/`env`, секции, self-правки, последний admin) |
| 401 | нет/невалиден Bearer; на админке legacy machine-токен тоже 401 |
| 403 | нет секции; viewer/prompter пишет не то; admin-only эндпоинт (`DELETE /users/{id}`, `PUT /users/roles`) |
| 404 | нет объекта, отключённый/неизвестный MCP, админ-цель для не-админа, любой неизвестный `/api/*` |
| 429 | лок логина (5+ неудач с IP за 10 мин) |
| 502 | MCP-сервер не running (tools/stats) |
