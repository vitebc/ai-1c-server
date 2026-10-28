# API бэкенда

Базовый URL: `http://<host>:8000` (`BACKEND_PORT`; dev `:8001`, prod `:8000`).
Все тела — JSON, кодировка UTF-8.

Авторизация: в **prod** задан `JWT_SECRET` — клиент (форма 1С) шлёт
`Authorization: Bearer <HS256 JWT c sub = onec_id>`; токен пробрасывается в 1С,
RLS применяет платформа. В **dev** `JWT_SECRET` пуст → сервисный
`ONEC_USERNAME`/`ONEC_PASSWORD` (Basic). Защищённые JWT эндпоинты: `POST /chat`
и `GET /tools` с `base_url`/`base_name`; без токена → 401.
Пользователь 1С передаётся полем `user_id` в теле (профиль прав из
`users.access_profile`).

## `GET /health`

Проверка живости (healthcheck compose).

Ответ `200`: `{"status": "ok"}`.

## `GET /tools`

Полный реестр доступных инструментов (динамически).

- `mock`: курируемые моки + `search_knowledge_base` + `get_pattern` (если есть паттерны).
- `live`: курируемые `A1C_Инструменты` + любые `a1c_Инструмент*`/`mcp_КонтейнерыИнструментов` из прокси (схема `inputSchema` из 1С уходит модели напрямую, вызов проксируется) + те же локальные. Новый тул в расширении 1С появится тут **без правки кода бэкенда** — достаточно добавить его имя в `AGENT.md: tools:`.
- `?base_url=http://srvr/Ref` + `?base_name=` — реестр конкретной базы через прямой JSON-RPC в `{base_url}/hs/mcp/rpc` (тот же резолвер, что в `POST /chat`: мапа исключений `ONEC_BASES` побеждает присланное → валидный `base_url` из запроса). Мусор → `400`, пусто всё — штатный путь. Форма 1С при старте дергает именно этот эндпоинт для startup-check.
- Реестр конкретной базы требует JWT (`JWT_SECRET` задан) — иначе `401`: токен уходит в 1С для per-user RLS. Общий реестр без базы (`GET /tools` без query) — диагностика, авторизации не требует.

| Query | Назначение |
|---|---|
| `base_url` (опц., ≤256) | Корень публикации базы (`http://srvr/Ref`, регистр Ref точный) |
| `base_name` (опц., ≤128) | Имя ИБ (НРег); сначала ищется в `ONEC_BASES` |

Ответ `200`:
```json
{"mode": "live", "base_url": "http://srvr/Ref", "tools": [{"name": "execute_select", "server": "default", "description": "...", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}}]}
```

Имена из этого списка — источник правды для поля `tools` в `AGENT.md`. Тулзы агрегатора (`AGG_MCP_URL`) — полными именами `server__tool` с тегом `server`; в `AGENT.md` агент выбирает их полем `mcp: [default, search-ka-update, ...]` + именами в `tools`. Недоступный агрегатор из списка тихо выпадает (warning в лог, чат живёт на остальных тулзах); список агрегатора кешируется (`AGG_MCP_CACHE_TTL`, дефолт 300с).

Поле `server` в ответе: `default` (прокси/прямой JSON-RPC в 1С), `local`
(`search_knowledge_base`, `get_pattern`, `list_registry` —
вне отбора по `mcp`), либо имя подсервера агрегатора.

## `GET /agents`

Список рантайм-агентов для дропдауна формы 1С. Файлы перечитываются
на каждый запрос — новый `backend/agents/<name>/AGENT.md` виден сразу
(в compose `agents/` примонтирован volume-mount, пересборка не нужна).

| Query | Назначение |
|---|---|
| `base_name` (опц., ≤128) | Имя базы сессии (НРег) — участвует в фильтре доступности |

Заголовок `Authorization: Bearer <JWT>` (если `JWT_SECRET` задан) — `sub`
трактуется как onec_id и участвует в фильтре. Без валидного JWT отдаются
только агенты без ограничений (безопасный дефолт для старых клиентов).

Ответ `200`:
```json
{
  "default": "assistant",
  "agents": [
    {
      "name": "assistant",
      "title": "Ассистент",
      "description": "общие вопросы по 1С и базе знаний",
      "tools": ["get_stock_balance", "search_knowledge_base"],
      "skills": ["*"],
      "mcp": ["default"],
      "restricted": false,
      "bases": ["ca2_ai", "doc3_test"],
      "users": []
    }
  ],
  "errors": []
}
```
- `default` — агент, когда в `POST /chat` поле `agent` пустое.
- `skills: ["*"]` — агенту доступны все скилы; `[]` — ни одного.
- `mcp` — источники инструментов агента (`Agent.mcp_servers`): `default`
  (прокси 1С) + подсерверы агрегатора. Тулза `server__tool` попадает в
  агента только если её сервер в этом списке; локальные
  (`search_knowledge_base`, `get_pattern`) доступны всегда вне отбора.
- `restricted` / `bases` / `users` — ограничения доступности (см. ниже).
- `errors` — битые `AGENT.md` (пропущены, чат не роняют).
- `max_rounds` в `AGENT.md` — оверрайд лимита (пусто = дефолт 15; у `tz-helper` 8).

### Доступность агентов

Три опциональных поля frontmatter `AGENT.md`:

| Поле | Семантика |
|---|---|
| `restricted: true` | агент недоступен **никому** (переопределяет `bases`/`users`) |
| `bases: [...]` | имена баз из мапы `ONEC_BASES`; пусто = все; сравнение без учёта регистра |
| `users: [...]` | onec_id пользователей 1С; пусто = все |

Виден, если `restricted == false` **И** (bases пуст ИЛИ база сессии ∈ bases)
**И** (users пуст ИЛИ onec_id ∈ users). Без `base_name` в запросе видны только
агенты с пустым `bases`.

В `POST /chat`: явный выбор невидимого агента → **403** с расшифровкой
(`агент X недоступен для этой базы/пользователя (…)`); залипший в сессии
невидимый агент молча сбрасывается на первый доступный; нет доступных →
403 «нет доступных агентов для этой базы/пользователя».

## `GET /skills`

Список рантайм-скилов (`backend/skills/*/SKILL.md`, тоже без рестарта).
Форма 1С поле `skill` не шлёт (всегда авто), эндпоинт — для диагностики
и API-клиентов.

| Query | Назначение |
|---|---|
| `agent` (опц.) | Фильтр скилов по агенту; неизвестный агент → `404` |

Ответ `200`:
```json
{
  "skills": [{"name": "zakazy-prokudina", "description": "...", "tools": ["get_counterparty"]}],
  "errors": []
}
```

## `POST /chat`

Вопрос → агент → ответ. Два режима: SSE-стрим (форма 1С) и фоновый
(`?background=true` + опрос результата).

Тело запроса:
```json
{
  "message": "покажи пять последних заказов Прокудина",
  "session_id": 12,
  "user_id": "ИвановИИ",
  "attachments": [{"name": "фото.jpg", "mime": "image/jpeg", "content_base64": "..."}],
  "context_size": 5,
  "base_name": "ka2",
  "base_url": "http://srvr/ka2",
  "agent": "assistant",
  "skill": "zakazy-prokudina"
}
```
| Поле | Обяз. | Лимиты | Назначение |
|---|---|---|---|
| `message` | да | 1–20000 | Вопрос пользователя |
| `session_id` | нет | — | Сессия бэкенда (история). Чужая `base_name` → новая сессия |
| `user_id` | нет | дефолт `dev` | `ИмяПользователя()` из 1С; профиль прав из `users.access_profile` |
| `attachments` | нет | ≤10, `content_base64` ≤20MB (алиас `data_base64`) | Вложения; в БД пишется только имя файла; больше 10 → `413` |
| `context_size` | нет | 1–100 | Пар user/assistant в LLM; дефолт — последние 20 пар |
| `base_name` | нет | ≤128 | Имя ИБ 1С (НРег), считает BSL |
| `base_url` | нет | ≤256 | Корень публикации базы (`http://srvr/Ref` из Srvr/Ref строки соединения, регистр Ref точный). Бэкенд ходит в `{base_url}/hs/mcp/rpc` напрямую, минуя прокси: вопрос из базы X отвечает база X. Пусто — штатный путь (mock/прокси). Мусор → `400` |
| `agent` | нет | ≤64 | Агент; пусто → дефолт (`assistant`), залипает в сессии |
| `skill` | нет | ≤64 | Скил; пусто → авто top-1 по description среди скилов агента (только при score ≥ `skill_match_threshold`, дефолт 0.3; иначе полный набор тулзов агента) |

Резолв базы: мапа исключений `ONEC_BASES` побеждает присланный `base_url`, иначе валидный `base_url` из запроса. Имя есть, а адреса нигде нет → громкая `400` с эхом (`проверьте адрес публикации`, сессия не заводится) вместо молчаливого ответа чужой базы. Форма 1С при старте проверяет себя через `GET /tools?base_name=&base_url=` и показывает баннер, если агент недоступен.

Ошибки: `400` — мусор в `base_url` / имя без адреса (`проверьте адрес публикации`, сессия не заводится);
`401` — `JWT_SECRET` задан, но токен не передан/невалиден (per-user RLS);
`403` — агент недоступен для этой базы/пользователя (явный выбор) либо нет ни одного доступного агента;
`404` — `session not found`, `agent not found`, `skill not found`,
`skill not available for agent`; `413` — больше 10 вложений;
`500` — в проекте нет ни одного агента.
Предохранитель петли (`agent_max_consecutive_errors`, дефолт 3): после N ошибок
инструментов подряд ответом приходит честное «не могу обратиться к базе 1С»
вместо долбёжки упавшего шлюза.

### Режим SSE (по умолчанию)

`Content-Type: text/event-stream`, события:
- `event: tool` → `{"tool": "<имя>"}` — каждый вызов инструмента;
- `event: answer` → `{"delta": "<кусок ~500 символов>"}` — текст ответа кусками;
- `event: done` → `{"session_id": 12, "agent": "assistant", "skill": "zakazy-prokudina", "model": "qwen3.8-27b-1C", "elapsed_s": 4.2, "prompt_tokens": 1200, "completion_tokens": 150, "total_tokens": 1350, "rounds": 3, "tool_errors": 0}`.
  Токены — сумма `usage` OpenAI-совместимого API по всем раундам (провайдер без usage даёт нули); `elapsed_s` — серверное время выполнения.

Падение LLM не даёт HTTP 500: ошибка приходит обычным `answer`-текстом
с подсказкой про `.env` (`LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`).

### Фоновый режим (`POST /chat?background=true`)

Для BSL без стриминга. Ответ `200`: `{"job_id": "...", "session_id": 12, "status": "running", "agent": "assistant"}`.

## `GET /chat/result/{job_id}`

Опрос фоновой задачи.

- `running`: `{"job_id", "status": "running", "session_id"}`;
- `done`: `{"job_id", "status": "done", "session_id", "agent", "skill", "model", "elapsed_s", "prompt_tokens", "completion_tokens", "total_tokens", "answer", "rounds", "tool_calls", "tool_errors"}`;
- `error`: `{"job_id", "status": "error", "error", "session_id"}`;
- неизвестный `job_id` → `404`.

Задачи живут в памяти процесса (`_background_jobs`): рестарт бэкенда теряет их,
идемпотентного хранилища нет.

## `GET /stats/requests`

Журнал обращений (`chat_requests`) с фильтрами и пагинацией. Без авторизации
(закрытый контур, как остальные `/stats`).

| Query | Тип/лимиты | Назначение |
|---|---|---|
| `user_id` | ≤128 | пользователь 1С |
| `base_name` | ≤128 | имя базы сессии |
| `agent` | ≤64 | рантайм-агент |
| `skill` | ≤64 | применённый скил |
| `status` | `ok\|error` | результат |
| `from`, `to` | ISO datetime | период по `created_at` (tzinfo снимается) |
| `limit` | 1–500, дефолт 50 | размер страницы |
| `offset` | ≥0, дефолт 0 | смещение |

Ответ `200`: `{"total": <всего по фильтру>, "items": [...]}`.

Поля элемента: `id, user_id, session_id, base_name, base_url, agent, skill, model, question, answer, status, error, prompt_tokens, completion_tokens, total_tokens, rounds, tool_calls, elapsed_s, created_at`.
`question`/`answer` обрезаны 500 символами, `error` — 1000.

Обращения с тестовыми `user_id` (префиксы `test-`, `agent-u`, `skill-u`) в
статистику не пишутся.

## `GET /stats/summary`

Сводка за период (по умолчанию — последние 24 часа), тот же формат `from`/`to`.

Ответ `200`:
```json
{
  "total": 42,
  "tokens": 128000,
  "avg_elapsed_s": 4.2,
  "by_user": [{"user_id": "ИвановИИ", "count": 10, "tokens": 30000}],
  "by_base": [{"base_name": "ca2_ai", "count": 30, "tokens": 90000}],
  "by_agent": [{"agent": "assistant", "count": 42}]
}
```

## `GET /stats/distinct`

Уникальные значения для фильтров UI (без параметров):
`{"user_ids": [...], "base_names": [...], "agents": [...]}`.

## `GET /stats/onec`

Дашборд публикации 1С из `MCP_ONEC_URL` (адрес, который отдаётся mcp-proxy).
Бэкенд опрашивает его напрямую тем же контрактом, что и чат:
`POST {url}/hs/mcp/rpc`, JSON-RPC `tools/list` с Basic
(`ONEC_USERNAME`/`ONEC_PASSWORD`), таймаут 15 с.

Ответ `200` (всегда): `{"url", "configured", "ok", "tools", "elapsed_ms", "error"}`.
- `MCP_ONEC_URL` пуст → `{"configured": false, "error": "MCP_ONEC_URL не задан"}`, опрос не делается;
- `tools` — число инструментов (не список), `null` если база недоступна;
- ошибка сети/HTTP/JSON не роняет эндпоинт — всё в поле `error`.
