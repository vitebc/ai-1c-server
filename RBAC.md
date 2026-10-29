# Матрица ролей (RBAC)

Документация по системе доступа: роли, секции, матрица «роль → разделы»,
per-user переопределения и маппинг API-путей на секции.

Источники правды:

- `src/auth/mod.rs` — константы ролей/секций, `base_sections`, `role_base_sections`,
  `effective_sections`, `section_for`, `can_write`, `check_access`.
- `admin-ui/src/pages/Users.tsx` — UI матрицы (`SECTION_GROUPS`, `RolesMatrix`,
  `SectionsEditor`).
- `admin-ui/src/App.tsx` — защита навигации и страниц (`canSee`, `Guard`).

## Модель доступа

Доступ пользователя к API-путю определяется в два шага
(`check_access`, `src/auth/mod.rs:790`):

1. **Секция пути** (`section_for`, `src/auth/mod.rs:538`) — путь маппится на одну
   секцию из `SECTIONS` (или псевдо-секцию). Секции пользователя = базовые секции
   его роли + per-user переопределения. Нет секции → **403**.
2. **Право записи** (`can_write`, `src/auth/mod.rs:778`) — для методов кроме GET
   (кроме смены своего пароля) нужна роль, которой эта запись разрешена:
   - `admin` / `operator` — пишут везде, где есть секция;
   - `prompter` — только `/api/admin/agent-files/{agents,skills,patterns}`;
   - `viewer` (и любые неизвестные роли) — read-only.

Персональные переопределения секций **не дают право записи** — они только
вычитают/возвращают секции внутри роли.

### Специальные токен-идентичности

| Идентичность | Когда | Доступ |
|---|---|---|
| `AuthIdentity::system()` | legacy machine-токен на MCP-шлюзе | все секции, обход проверок (`system: true`) |
| `AuthIdentity::guest()` | MCP-шлюз при `auth_required=0` | все секции, «guest» в UI |
| `AuthIdentity::of(user)` | JWT (логин/пароль) | по ролям и переопределениям |

JWT: HS256, claims `{sub: user_id, username, exp}`, секрет — `server_settings.jwt_secret`,
сессия 12h / remember 7d. Админка **всегда** требует JWT (machine-токен → 401);
`auth_required` гейтит только MCP-шлюз.

## Роли

| Роль | Назначение | Запись | Настраивается админом |
|---|---|---|---|
| `admin` | полный доступ, всегда все секции | везде | **нет** (всегда full) |
| `operator` | рабочие разделы: MCP, модели, агенты, контент, настройки | везде в рамках своих секций | да |
| `viewer` | просмотр | только свой пароль | да |
| `prompter` | как viewer + правка файлов агентов/скиллов/паттернов (промпты) | только `agent-files/{agents,skills,patterns}` | да |

Константы: `ROLE_ADMIN/OPERATOR/VIEWER/PROMPTER` (`src/auth/mod.rs:136-141`).
Настраиваемые роли — `CONFIGURABLE_ROLES = [operator, viewer, prompter]`.

## Секции

Полный список — `SECTIONS` (`src/auth/mod.rs:144`), 22 шт.:

| Секция | Раздел UI / API |
|---|---|
| `dashboard` | Dashboard + Статистика + `/status`, `/agent-backend/stats`; fallback-секция неизвестных путей |
| `mcp-servers` | MCP Servers; весь MCP-шлюз (`/api/mcp*`, `/api/mcp-skills/*`) и `/reindex` |
| `models` | Models (провайдеры моделей), `model-providers/*` |
| `agent-studio` | **legacy зонтик**: в UI даёт вход в студию если есть любая вкладка; API-путей не маппится — см. «Legacy-секции» |
| `agent-agents` | вкладка Agents (CRUD агентов, `agent-files/agents/*`) |
| `agent-skills` | вкладка Agent Skills (`agent-files/skills/*`) |
| `agent-patterns` | вкладка Patterns (`agent-files/patterns/*`) |
| `agent-changes` | Изменения агентов (git-история, diff, revert; `agent-changes/*`) |
| `agent-backend` | вкладка Backend: start/stop/logs бэкенда, `agent-backend/*` кроме перечисленных ниже |
| `agent-rag` | База знаний (RAG): загрузка/переинжест/удаление корпуса, `agent-backend/rag/*` |
| `bases1c` | Базы 1С (`Bases1c.tsx`): мапа баз и search-мапа, `agent-backend/{bases,search-maps}*` |
| `skills` | серверные скиллы (sidebar), `skills/*` |
| `bsl-ls` | BSL Language Server, `bsl-ls/*` |
| `configs` | Config Profiles, `config-profiles/*` |
| `client-versions` | Client Versions, `client-versions/*` |
| `clients` | Clients (подключённые клиенты), `clients` |
| `logs` | Logs (серверные логи), `logs*` |
| `settings` | Settings, `settings` |
| `fs` | файловый браузер для выбора путей/бинарников, `fs/browse` |
| `env` | Agent Studio Config (.env): `agent-backend/env` |
| `users` | Users (управление пользователями), `users*` |
| `auth-manage` | API-токен: `auth/token`, `auth/rotate` |

### Псевдо-секции

Не показываются в матрице, используются только в `section_for`:

| Псевдо-секция | Пути | Правило |
|---|---|---|
| `__self` | `auth/me`, `auth/password` | любой залогиненный |
| `__agent_files_any` | `agent-files` (обзор), `agent-files/tools`, `agent-files/mcp-options`, `agent-backend/live`, `model-providers/options` | достаточно **любой** из `AGENT_READ_SECTIONS`: `agent-agents`, `agent-skills`, `agent-patterns`, `agent-backend` (`src/auth/mod.rs:171`) |

## Матрица по умолчанию (хардкод)

`base_sections` (`src/auth/mod.rs:178`). Это дефолты «из коробки»; админ может
переопределить их через UI/PUT (см. ниже).

| Секция | admin | operator | viewer | prompter |
|---|:-:|:-:|:-:|:-:|
| dashboard | ✓ | ✓ | ✓ | ✓ |
| mcp-servers | ✓ | ✓ | ✓ | ✓ |
| models | ✓ | ✓ | ✓ | ✓ |
| agent-studio (legacy) | ✓ | ✓ | — | — |
| agent-agents | ✓ | ✓ | ✓ | ✓ |
| agent-skills | ✓ | ✓ | ✓ | ✓ |
| agent-patterns | ✓ | ✓ | ✓ | ✓ |
| agent-changes | ✓ | ✓ | — | ✓ |
| agent-backend | ✓ | ✓ | — | — |
| agent-rag | ✓ | ✓ | — | — |
| bases1c | ✓ | ✓ | — | ✓ |
| skills | ✓ | ✓ | ✓ | ✓ |
| bsl-ls | ✓ | ✓ | ✓ | ✓ |
| configs | ✓ | ✓ | ✓ | ✓ |
| client-versions | ✓ | ✓ | ✓ | ✓ |
| clients | ✓ | ✓ | ✓ | ✓ |
| logs | ✓ | ✓ | ✓ | ✓ |
| settings | ✓ | ✓ | — | — |
| fs | ✓ | ✓ | — | — |
| env | ✓ | ✓ | — | — |
| users | ✓ | — | — | — |
| auth-manage | ✓ | — | — | — |

Итого: admin 22, operator 19, viewer 12, prompter 14.

## Переопределение матрицы (admin)

- Хранится в `server_settings.role_sections` (JSON):
  `{"operator": [...], "viewer": [...], "prompter": [...]}`.
- API: `GET /api/admin/users/roles` (любой со секцией `users`) и
  **`PUT /api/admin/users/roles` — только admin** (иначе 403), тело
  `{roles: {operator: [...], viewer: [...], prompter: [...]}}`.
- UI: вкладка Users → блок «Разделы по ролям (по умолчанию)» — чекбоксы для
  operator/viewer/prompter; кнопка OK активна только при изменении.
- При чтении/записи неизвестные секции отбрасываются (`SECTIONS.contains`),
  роли фильтруются по `CONFIGURABLE_ROLES`. Admin в матрицу не попадает —
  у него всегда все секции.
- Если ключа роли нет в `role_sections` — используются хардкод-дефолты.

## Per-user переопределения

- Хранятся в `users.sections` (JSON `{секция: bool}`), редактируются в Users →
  иконка секций пользователя (`SectionsEditor`, три состояния: default/allow/deny).
- **Только внутри роли**: `false` — убрать секцию у конкретного юзера, `true` —
  вернуть убранную. Выдать секцию **вне** роли нельзя — для этого меняется
  матрица ролей (admin-only).
- Переопределения не дают право записи: запись определяется только ролью (`can_write`).
- Свою роль/enable/секции пользователь менять не может; чужие секции — только admin.

## Маппинг путей → секции

Полная таблица веток `section_for` (`src/auth/mod.rs:538`). Порядок важен —
первое совпадение побеждает:

| Путь (префикс после `/api/admin/`) | Секция |
|---|---|
| `auth/login` | публичный (без секции) |
| `auth/me`, `auth/password` | `__self` |
| `/api/mcp*`, `/api/mcp-skills/*` (MCP-шлюз) | `mcp-servers` |
| `mcp-servers*`, `reindex` | `mcp-servers` |
| `model-providers/options` | `__agent_files_any` |
| `model-providers*` | `models` |
| `agent-files` (обзор), `agent-files/tools`, `agent-files/mcp-options` | `__agent_files_any` |
| `agent-backend/live` | `__agent_files_any` |
| `agent-files/agents*` | `agent-agents` |
| `agent-files/skills*` | `agent-skills` |
| `agent-files/patterns*` | `agent-patterns` |
| `agent-files/base-users` | `agent-agents` (пользователи 1С для формы агента) |
| `agent-changes*` | `agent-changes` |
| `agent-backend/bases*`, `agent-backend/search-maps*` | `bases1c` |
| `agent-backend/env*` | `env` |
| `agent-backend/stats*` | `dashboard` |
| `agent-backend/rag*` | `agent-rag` |
| `agent-backend*` (остальное) | `agent-backend` |
| `skills*` | `skills` |
| `bsl-ls*` | `bsl-ls` |
| `config-profiles*` | `configs` |
| `client-versions*` | `client-versions` |
| `clients` | `clients` |
| `logs*` | `logs` |
| `fs/browse` | `fs` |
| `settings` | `settings` |
| `auth/token`, `auth/rotate` | `auth-manage` |
| `status` | `dashboard` |
| `users*` | `users` |
| **остальные `/api/admin/*`** | `dashboard` (fallback) |

## Защита в UI

- Навигация: пункт виден, если `canSee(me, section)` (`App.tsx:30`) — секция в
  `me.sections`, либо для `agent-studio` — любая из вкладок студии.
- Страницы: обёртка `Guard` (`App.tsx:195`) показывает «Нет доступа (роль: …)»
  при отсутствии секции; у `/agent-studio` дополнительно `anyOf` по вкладкам.
- Вкладки Agent Studio фильтруются по `TAB_SECTION` (`AgentStudio.tsx:12`):
  agents→`agent-agents`, skills→`agent-skills`, patterns→`agent-patterns`,
  backend→`agent-backend`, env→`env`. Страница RAG — отдельная, секция `agent-rag`.

## Legacy-секции

- **`agent-studio`** — исторический зонтик студии. В UI вход в студию даёт любая
  вкладка (`anyOf`), в API ни один путь на неё не маппится, поэтому чекбокс в
  матрице ничего не гейтит и в UI больше не показывается (коммит `222566e`).
  Секция остаётся в `SECTIONS` и может встречаться в старых записях
  `role_sections` — при сохранении матрицы неизвестные/legacy-секции отбрасываются.

## Ошибки

| Код | Когда |
|---|---|
| 401 | нет Bearer / битый JWT / machine-токен на `/api/admin/*` / пользователь disabled |
| 403 | нет секции пути; viewer/prompter пишет не в своё; admin-only эндпоинт (`PUT /users/roles`, `DELETE /users/{id}`, смена роли на admin) |
| 429 | >5 неудачных логинов с IP за 10 мин → блокировка 5 мин |

## Примеры

```bash
# Токен
JWT=$(curl -s -X POST http://localhost:9224/api/admin/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"..."}' | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")

# Матрица по умолчанию (эффективная: БД поверх хардкода)
curl -s http://localhost:9224/api/admin/users/roles -H "Authorization: Bearer $JWT"

# Изменить дефолты роли (только admin)
curl -s -X PUT http://localhost:9224/api/admin/users/roles \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"roles":{"viewer":["dashboard","logs"]}}'

# Персонально убрать секцию у юзера (внутри его роли)
curl -s -X PUT http://localhost:9224/api/admin/users/<id> \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d '{"sections":{"logs":false}}'
```
