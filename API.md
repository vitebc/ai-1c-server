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

Полное описание — в [RBAC.md](RBAC.md): роли, матрица «роль → секции»,
переопределения (матрица + per-user), псевдо-секции, маппинг путей.

Кратко: 4 роли (`admin` full, `operator`, `viewer` read-only, `prompter` —
viewer + правка agent/skill/pattern-файлов); 22 секции; дефолты ролей
переопределяются админом через `GET/PUT /api/admin/users/roles`
(`server_settings.role_sections`, ключи только `operator|viewer|prompter`);
per-user `sections` — только вычитание внутри роли; нет секции → 403;
>5 неудачных логинов с IP за 10 мин → 429 на 5 мин.

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
| POST/GET | `/api/mcp/{id\|name}` | один сервер: POST — Streamable HTTP, GET — SSE |
| POST/GET | `/api/mcp/{id\|name}/mcp` | алиас (назад совместим) |
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

### AI Agent Studio (проект `agent/` в этом монорепо)

Корень проекта — `server_settings(agent_project_root)` (по умолчанию
`$HOME/project/ai-1c-server/agent`), файлы: `backend/agents/<name>/AGENT.md`,
`backend/skills/<name>/SKILL.md`, `backend/patterns/<name>.md`.
История правок коммитится в монорепо (корень git ищется выше `agent/`).

| Метод | Путь | Описание |
|---|---|---|
| GET | `/agent-files` | overview: `{root, root_exists, agents[], skills[], patterns[]}` — фильтруется по подсекциям |
| GET | `/agent-files/tools` | статический список известных тулзов (строки), для подсказок в редакторе |
| GET | `/agent-files/mcp-options` | `{servers: [{name, running}]}` включённых MCP для мультиселекта редактора (без команд/URL, секция `__agent_files_any`) |
| GET | `/agent-files/base-users?base=` | уникальные пользователи 1С базы через её тулзу `get_users` (Basic из `MCP_ONEC_USERNAME/PASSWORD` .env). Ответ `{base, cached, users[]}`. Резолв: имя из `bases.conf` → `ONEC_BASES` из .env → прямой URL. Кэш 5 мин (по имени и по URL). Ошибка базы/`.env` → 400 |
| POST | `/agent-files/agents\|skills\|patterns` | создать (имя `^[a-z0-9-]+$`, max 64) |
| PUT/DELETE | `/agent-files/agents/{name}`, `.../skills/{name}`, `.../patterns/{name}` | изменить / удалить (переименование = перемещение папки) |
| POST | `/agent-files/patterns/{name}/toggle` | включить/выключить паттерн (`enabled:` во frontmatter), возвращает обновлённый `PatternItem` |

- Подсекции: `agent-agents`, `agent-skills`, `agent-patterns`.
- Тела: агент `{name, title, description, tools[], skills[], mcp[], restricted?, bases[], users[], model?, provider?, body}`; скилл `{name, description, tools[], body}`; паттерн `{name, description, body}`.
- Канонический порядок frontmatter агента: `name, title, description, tools, skills, mcp, restricted, bases, users, model, provider`. `mcp` — список (`mcp: [a, b]`), совместим с `Agent.mcp_servers` бэкенда; `provider` бэкендом игнорируется.
- Бэкенд перечитывает файлы на каждый запрос — рестарт не нужен. Live-видимость проверяется через `/agent-backend/live/*`.

### Доступность агентов (bases / users / restricted)

Frontmatter `AGENT.md` поддерживает три опциональных поля:

| Поле | Тип | Семантика |
|---|---|---|
| `restricted` | bool | `true` — агент недоступен **никому** (переопределяет bases/users). В файле пишется только если `true`. |
| `bases` | string[] | Имена баз из мапы ONEC_BASES. Пусто/отсутствует = все базы. Сравнение — без учёта регистра. |
| `users` | string[] | onec_id пользователей 1С. Пусто/отсутствует = все пользователи. Сравнение — как есть. |

Агент виден, если: `restricted == false` **И** (bases пуст ИЛИ база сессии ∈ bases) **И** (users пуст ИЛИ onec_id ∈ users).

#### Клиентский контракт (форма 1С)

Форма 1С **обязана** передавать оба параметра, иначе ограниченные агенты будут скрыты:

**`GET /agents`** (дропдаун):
```http
GET /agents?base_name=<имя из мапы ONEC_BASES> HTTP/1.1
Authorization: Bearer <JWT HS256, sub = onec_id>
```
- `base_name` — имя базы (не URL), в нижнем регистре. Берётся из текущей сессии 1С.
- JWT — общий секрет (`YnSdgu3G...`), payload `{"sub": "<onec_id>", "exp": <unix_ts>}`.

**`POST /chat`**:
```json
{
  "message": "...",
  "user_id": "<onec_id>",
  "base_name": "<имя из мапы ONEC_BASES>",
  "agent": "<имя>"
}
```
- `Authorization: Bearer <JWT>` — тот же токен.
- `base_name` — **обязателен**, если агент ограничен по базам. Без него `visible_for(None, ...)` → агент с непустым `bases` невидим.

**Поведение без параметров (безопасный дефолт):**
- Без JWT → видны только агенты без ограничений (`restricted=false`, `bases=[]`, `users=[]`).
- Без `base_name` → видны только агенты с пустым `bases`.
- Явный выбор невидимого агента в `/chat` → **403** «агент X недоступен для этой базы/пользователя».
- Залипший в сессии невидимый агент → fallback на дефолт (без 403).

#### Логирование

Бэкенд логирует входящие `base_name` и наличие JWT на debug-уровне:
- `GET /agents`: `list_agents base_name=<...> jwt=<yes|no> visible=<n>`
- `POST /chat`: `chat base_name=<...> user_id=<...> agent=<...> jwt=<yes|no>`

Это позволяет диагностировать проблемы с доступностью по журналу без изменения кода.

### История правок Agent Studio (`/agent-changes`)

Каждая create/update/delete через `/agent-files/*` коммитится в git проекта агента
(корень ищется выше `agent/`, так что в монорепо это коммит в
`ai-1c-server`) и пишется в таблицу `agent_changes`. Секция `agent-changes`.
Команды git с таймаутом 30 с; упавший коммит не ломает API — файл уже на диске,
а строка аудита просто не появляется (warning в лог).

| Метод | Путь | Описание |
|---|---|---|
| GET | `/agent-changes` | постраничная история `{items[], total}`. Фильтры: `user_id`, `entity_type` (`agent\|skill\|pattern`), `entity_name` (LIKE), `action` (`create\|update\|delete\|revert`), `from`, `to` (ISO), `limit` (≤200, дефолт 50), `offset`. Сортировка `timestamp DESC, id DESC` |
| GET | `/agent-changes/distinct` | `{users[], entities: [[type, name], ...]}` — значения для фильтров UI |
| GET | `/agent-changes/{id}/diff` | `{commit, diff}` — unified diff коммита (только изменённые строки) |
| POST | `/agent-changes/{id}/revert` | `git revert` выбранного коммита → **новый** коммит + новая строка аудита с `action: revert` → `{ok, commit}`. Откат удаления восстанавливает объект, откат создания — удаляет |
| DELETE | `/agent-changes/purge?days=` | удалить строки старше N дней (1–365, дефолт 30) → `{ok, deleted}` |

Запись аудита: `{id, timestamp, user_id, username, entity_type, entity_name, action, git_commit_hash, diff_summary}`.

### Agent Backend (docker compose)

| Метод | Путь | Описание |
|---|---|---|
| GET | `/agent-backend/status` | `{services[], profiles[], backend_url, project_root, ...}` (секция `agent-backend`) |
| POST | `/agent-backend/up` | `{services[]?, profiles[]?}` — сервисы из allowlist `postgres, backend, tei, mcp-proxy`, профили `rag, onec`; прочее → 400 |
| POST | `/agent-backend/stop`, `/agent-backend/restart` | те же тела |
| GET | `/agent-backend/logs?service=&tail=&timestamps=&grep=` | compose-логи; `tail` 1–2000 (дефолт 200), `grep` — регистронезависимый фильтр подстроки |
| GET/PUT | `/agent-backend/env` | `.env` по allowlist (32 ключа), секреты массируются на чтении; запись — секция `env` |
| GET | `/agent-backend/live/agents\|skills[?agent=]\|tools[?base_url=]` | живое состояние бэкенда: `{reachable, data}` / `{reachable, error}`; секция `__agent_files_any`. JWT админки пробрасывается в бэкенд (единый `JWT_SECRET`) — без него защищённые бэкенд-эндпоинты отдают 401 |
| GET | `/agent-backend/live/onec-tools` | проба публикации 1С из `MCP_ONEC_URL`: JSON-RPC `tools/list` напрямую, Basic из `.env` → `{ok, url, tools_count}` либо `{ok: false, error}`. `405/401/403` считаются «online» (`tools_count: null`, `note: "online"`) — Streamable HTTP требует handshake; красная только при connection-level ошибке |
| GET | `/agent-backend/bases` | `{source: "bases.conf"\|"env", bases: [{name, url}]}` — активная мапа `ONEC_BASES` (секция `env`) |
| PUT | `/agent-backend/bases` | `{name, url}` — добавить/обновить базу; `name` — латиница/цифры/`_`, `url` — `http(s)://…`. Hot-reload бэкенда ≤2 с, рестарт не нужен |
| PUT | `/agent-backend/bases/{old_name}` | `{name, url}` — переименовать/обновить (ищет по `old_name`, иначе по `name`) |
| DELETE | `/agent-backend/bases/{name}` | убрать базу из мапы; нет такой → 400 |
| GET | `/agent-backend/stats/requests\|summary\|distinct` | прокси к бэкенду `/stats/*` → `{ok, data}` / `{ok: false, error}`; секция `dashboard`. Query пробрасываются как есть (фильтры `user_id`, `base_name`, `agent`, `skill`, `status`, `from`, `to`, `limit`, `offset`) |
| GET | `/agent-backend/rag/status` | состояние базы знаний: провайдер эмбеддингов, размерность, число документов/чанков, коллекции, пороги; секция `agent-backend` |
| GET | `/agent-backend/rag/documents?q=&collection=&limit=&offset=` | список документов корпуса с числом чанков; `q` — поиск по названию, `collection` — по коллекции |
| GET | `/agent-backend/rag/documents/{id}` | документ с чанками (предпросмотр того, что уходит в вектор); `chunks[].is_header` — служебный чанк-заголовок |
| POST | `/agent-backend/rag/documents` | загрузить документ: `{title, content, collection?, access_profile?, agent_name?, filename?}` → чистка, нарезка, эмбеддинг |
| DELETE | `/agent-backend/rag/documents/{id}` | удалить документ с чанками |
| POST | `/agent-backend/rag/search` | пробный поиск `{query, top_k?, min_score?}` — ровно то, что увидит агент (та же выдача и тот же порог отсечения) |
| POST | `/agent-backend/rag/reingest` | переинжест коллекции `{collection?, replace?, profile?, agent?, limit?}` из подпапки `KB_DIR/<collection>`; нет подпапки — 400 (в корень корпуса не переходим: залился бы весь корпус). Ответ — счётчики (`documents`, `chunks`, `removed`, `skipped`, `errors`) |
| DELETE | `/agent-backend/rag/collections/{name}` | удалить коллекцию целиком (документы и чанки) |

`bases.conf` — единственное место, где правятся базы вручную; бэкенд
перечитывает его по mtime (TTL 2 с). Файл отсутствует → fallback на `ONEC_BASES`
из `.env` (тогда правки через API недоступны, 400).

Секции: `/agent-backend/{status,up,stop,restart,logs}` → `agent-backend`;
`/agent-backend/env`, `/agent-backend/bases*` → `env`; `/agent-backend/stats*`
→ `dashboard`; `/agent-backend/live/*` → `__agent_files_any`.

### OpenCode Gateway (шлюз :9020)

Единый шлюз к серверам OpenCode (по одному на базу 1С): прокси API/SSE,
маршрутизация по базе (claim `base` из JWT → `X-1C-Base` → `?base=` →
путь `/b/{base}/api/...` → сервер по умолчанию), реестр сессий и RLS-мост
инструментов 1С.

**Порты:** prod держит `:9020`, dev — `:9025` (env `OPENCODE_GATEWAY_PORT`
в `~/.config/ai-1c-server/{dev,prod}.env`; БД не читает). Порядок
перезапуска: сначала prod, потом dev.

**Авторизация:** каждый запрос шлюза требует маркер — JWT пользователя 1С
(`Authorization: Bearer`, aud=`mcp`) или `X-Vitra-Token` (совпадение с
`server_settings.vitra_ai_token`, constant-time; пусто = выключено).
Иначе 401. Исключение — `GET /health` (без маркера, без раскрытия списка
серверов/сессий): `{ok: true, gateway: "opencode"}`. Анонимная Витра без JWT
не может вызывать инструменты 1С (`/onec/rpc` требует JWT пользователя).

**Админ API** (`/api/admin/opencode/*`, секция RBAC `opencode`):

| Метод | Путь | Описание |
|---|---|---|
| GET | `/opencode/status` | `{project_root, gateway_url, port, servers[]}` — на каждом сервере `healthy`, `plugin_generated`, `deps_installed` |
| GET/POST | `/opencode/servers` | список / создать `{name, title, config_dir, url, username, password, bases[], compose_service, compose_profile, onec_user, onec_password, enabled, is_default}` |
| GET/PUT/DELETE | `/opencode/servers/{id}` | по id или name; PUT — частичное (пустой `password`/`onec_password` = оставить) |
| POST | `/opencode/servers/{id}/up\|stop\|restart` | `docker compose <action> <compose_service>` в `project_root` |
| GET | `/opencode/servers/{id}/logs?tail=` | compose-логи |
| GET/PUT | `/opencode/servers/{id}/config` | `opencode.jsonc` (JSONC, валидация при записи); читается из `config_dir` сервера — каталог реестра должен совпадать с реальным (регистр важен) |
| GET | `/opencode/servers/{id}/agents` | плоские агенты `config/<server>/agents/*.md` (frontmatter + body) |
| PUT/DELETE | `/opencode/servers/{id}/agents/{name}` | создать/изменить / удалить агент |
| GET | `/opencode/servers/{id}/skills` | скилы `config/<server>/skills/*.md` |
| PUT/DELETE | `/opencode/servers/{id}/skills/{name}` | создать/изменить / удалить скилл |
| POST | `/opencode/servers/{id}/tools/sync` | 1С → `plugins/1c-tools/catalog.json` (Basic из `onec_user/onec_password`, база = первая из `bases`) → `{ok, count, path, token}` |
| POST | `/opencode/servers/{id}/tools/generate` | `catalog.json` → `plugins/1c-tools/index.ts` (плагин v2, каталог вшит литералом) + `package.json` (`@opencode/plugin: 2.1.4`) → `{ok, count, dir}` |
| POST | `/opencode/servers/{id}/tools/apply` | **одна кнопка**: sync → generate → `docker compose restart` (только если каталог изменился; без compose-сервиса — пропускаем) → `{ok, synced, generated, changed, restarted, dir}` |
| POST | `/opencode/servers/{id}/tools/install-deps` | `npm install @opencode/plugin` в конфиг-каталоге (один раз при первом развёртывании) |
| POST | `/opencode/servers/{id}/tools/test` | `{tool, arguments}` — прямой вызов 1С (не через плагин), для проверки до генерации |
| GET | `/opencode/servers/{id}/plugin/token` | токен плагина `X-OpenCode-Token` (HMAC от `JWT_SECRET` + name) |
| GET | `/opencode/sessions` | реестр сессий шлюза: `{session_id, server, user, base, has_jwt, expires_at}` |
| POST | `/opencode/sessions/drop` | `{session_id}` — убрать из реестра (после рестарта шлюза JWT теряется) |
| GET | `/opencode/logs?limit=` | логи обращений к шлюзу из LogBuffer (target `ai_1c_server::opencode::gateway`; дефолт 300; 401/ошибки — WARN, успехи — INFO; IP не логируется) |
| GET/PUT | `/opencode/vitra/token` | токен Витры: GET → `{token_set}` (значение не раскрывается), PUT `{token}` (пустая строка = выключить) |

**Gateway listener** (`:9020` prod / `:9025` dev):

- `POST /api/session` — создаёт сессию на целевом сервере OpenCode; шлюз
  кладёт в реестр `sessionID → {base, sub, JWT, exp}` (id из `data.id`).
- `POST /api/session/{id}/prompt`, `/wait`, `/message` — обновляют реестр.
- **RLS-мост** `POST /onec/rpc` — плагин `1c-tools` шлёт `{session_id, base?, params:{name, arguments}}` + `X-OpenCode-Token`; шлюз подставляет JWT пользователя 1С из реестра → `Authorization: Bearer <JWT>` на `{base}/hs/mcp/rpc`. Это per-user RLS: запрос в 1С идёт под пользователем из формы, а не сервисным.

**Плагин 1c-tools (OpenCode v2):** `config/<server>/plugins/1c-tools/index.ts`
— `Plugin.define({id: "onec-tools", setup(ctx) { ctx.tool.transform(...) }})`.
Каталог инструментов вшит литералом (без `fs`/`fetch` в `setup` — активация
не подвисает). Тулзы видны модели напрямую (`options.codemode: false`,
неймспейс `onec`). Вызовы через шлюз `/onec/rpc`.

**Кнопка «Применить»** (UI, вкладка Инструменты) = `POST /tools/apply`:
синхронизация каталога из 1С + генерация плагина + рестарт контейнера
(если каталог изменился). При добавлении/удалении тулзы в 1С — один клик.

**Маршрутизация по базе:** claim `base` из JWT → заголовок `X-1C-Base` →
query `?base=` → путь `/b/{base}/api/...` → сервер по умолчанию
(`is_default=true`). Неизвестная база — 404 со списком настроенных.

### Собственный API бэкенда агента (Python, `agent/`)

Админка ходит в бэкенд агента (FastAPI) не напрямую, а через
`/agent-backend/live/*` и `/agent-backend/stats/*`. Сам бэкенд — отдельный
HTTP-сервис (dev `:8001`, prod `:8000`), его контракт описан в
[`agent/backend/API.md`](agent/backend/API.md): `GET /health`, `GET /tools`,
`GET /agents`, `GET /skills`, `POST /chat` (SSE или `?background=true` +
`GET /chat/result/{job_id}`), `GET /stats/{requests,summary,distinct,onec}`.

```bash
# dev-бэкенд напрямую (без JWT — dev без per-user RLS)
curl -s 'http://localhost:8001/agents?base_name=ca2_ai' | python3 -m json.tool
curl -s -X POST 'http://localhost:8001/chat' -H 'Content-Type: application/json' \
  -d '{"message":"покажи остатки","user_id":"ИвановИИ","base_name":"ca2_ai","base_url":"http://192.168.0.69:81/ca2_ai"}'
```

**Контент — источник истины в prod.** Файлы `backend/{agents,skills,patterns}`
правятся прод-админкой; деплой кода их в prod не переносит. Dev — зеркало,
обновляется только по команде `agent/scripts/sync_from_prod.sh --apply`.
Бэкенд перечитывает файлы на каждый запрос — рестарт контейнера не нужен.

## Коды ошибок

| Код | Когда |
|---|---|
| 400 | валидация (имя, роль, JSON в `args`/`env`, секции, self-правки, последний admin) |
| 401 | нет/невалиден Bearer; на админке legacy machine-токен тоже 401 |
| 403 | нет секции; viewer/prompter пишет не то; admin-only эндпоинт (`DELETE /users/{id}`, `PUT /users/roles`) |
| 404 | нет объекта, отключённый/неизвестный MCP, админ-цель для не-админа, любой неизвестный `/api/*` |
| 429 | лок логина (5+ неудач с IP за 10 мин) |
| 502 | MCP-сервер не running (tools/stats) |
