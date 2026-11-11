# Code Index (индексы выгрузок 1С) в OpenCode — схема и примеры конфигов

> **Статус: работает. Серверы OpenCode НЕ изменены** (конфиги `/home/test/project/1C-opencode/config/*/opencode.jsonc` не тронуты).
> Индексы на SMB, serve'ы и демон под управлением systemd, агрегатор пробрасывает 361 тулзу.
> Подтверждено документацией: https://opencode.ai/v2/docs/mcp-servers, https://opencode.ai/v2/docs/permissions, https://opencode.ai/v2/docs/agents

## 1. Архитектура

```
SMB-шар /mnt/zhvv_ai/workspace/<КАТАЛОГ>          (источник: XML-выгрузки конфигураций)
        │  bsl-indexer index <SMB-path> --force   (индексация напрямую с SMB)
        ▼
Индексы на SMB: /mnt/zhvv_ai/workspace/<КАТАЛОГ>/.code-index/index.db
        │  (SQLite, journal_mode=OFF — форк bsl-indexer v1.16.0-patched)
        │  bsl-indexer serve --transport http --port 80xx --path <алиас>=<SMB-путь>
        ▼
MCP-эндпоинты http://127.0.0.1:80xx/mcp           (по одному на выгрузку)
        │  агрегатор ai-1c-server (записи MCP code-index-<алиас>)
        ▼
Серверы OpenCode (main/ka2/upp/doc3)              (mcp.servers.ci_<алиас>, remote, oauth:false)
        │  permissions per-agent (agents.<id>.permissions)
        ▼
Агенты видят ТОЛЬКО тулзы своих выгрузок
```

### Почему форк bsl-indexer и индексы на SMB

- SQLite WAL/локи на CIFS/SMB не работают (`database is locked`, зависания).
- Форк v1.16.0-patched: `PRAGMA journal_mode=OFF` + патч `flush_to_disk` (копирование через /tmp) — БД пишется прямо в SMB.
- Serve читает **SMB-БД** (`--path <алиас>=<SMB-путь>`) — индексы хранятся на шаре вместе с выгрузками.
- Исключение: `obrabotki` остаётся локально (зависает при чтении с SMB) — путь в юните указывает на `indexes/obrabotki`.
- Индексация: `./reindex.sh <алиас>` (CLI, пишет в SMB).

### Автозапуск — systemd user-юниты

| Юнит | Назначение |
|---|---|
| `code-index-daemon.service` | Демон индексации + health :8010 |
| `code-index-serve@.service` (template) | 9 инстансов serve'ов (8011–8019), карта алиас→путь внутри юнита |

Все юниты в `~/.config/systemd/user/`, включены (`WantedBy=default.target`), автоперезапуск при крахе.

### Алиасы и порты

| Алиас | SMB-каталог | Порт serve | Запись MCP в агрегаторе |
|---|---|---|---|
| `ka2` | `KA2` | 8011 | `code-index-ka2` → `http://127.0.0.1:8011/mcp` |
| `erp` | `ERP` | 8012 | `code-index-erp` → `http://127.0.0.1:8012/mcp` |
| `ktm` | `KTM` | 8013 | `code-index-ktm` → `http://127.0.0.1:8013/mcp` |
| `upp` | `UPP/UPP` | 8014 | `code-index-upp` → `http://127.0.0.1:8014/mcp` |
| `obrabotki` | `obrabotki` | 8015 | `code-index-obrabotki` → `http://127.0.0.1:8015/mcp` |
| `erp_ext` | `ERP_EXT` | 8016 | `code-index-erp_ext` → `http://127.0.0.1:8016/mcp` |
| `ka_market_ext` | `KA_MARKET_EXT` | 8017 | `code-index-ka_market_ext` → `http://127.0.0.1:8017/mcp` |
| `ka_rs_ext` | `KA_RS_EXT` | 8018 | `code-index-ka_rs_ext` → `http://127.0.0.1:8018/mcp` |
| `ka_td_ext` | `KA_TD_EXT` | 8019 | `code-index-ka_td_ext` → `http://127.0.0.1:8019/mcp` |

`KA_Update` — пустой, не индексируется.

Каждый serve отдаёт **42 тулзы** (25 универсальных + 17 для 1С), все с обязательным параметром `repo=<алиас>`.

## 2. Имена тулз и Code Mode

OpenCode называет MCP-тулзу `<server>_<tool>` (документация: mcp-servers → «Names»).
Для сервера `ci_ka2` тулзы называются `ci_ka2_get_function`, `ci_ka2_search_function`, …

**Code Mode включён по умолчанию** (`codemode: true`). Тулзы группируются в `tools.<server>.<tool>` и вызываются через встроенный инструмент `execute`:

```js
// внутри execute (Code Mode)
const r = await tools.ci_ka2.get_function({ repo: "ka2", name: "Провести" });
```

Изоляция по агентам делается **не** фильтром по `execute`, а точечными правилами на конкретные тулзы (см. §4).

## 3. Конфиг сервера OpenCode (`opencode.jsonc`)

### 3.1. Подключение выгрузок — `mcp.servers`

MCP в OpenCode 2.x — **только глобальный** (на уровне сервера/проекта). В схеме агента
(`agents.<id>.*`, frontmatter `.md`) полей для MCP нет — это подтверждено схемой
`https://opencode.ai/config.json` и доками. Поэтому все выгрузки подключаются в
`mcp.servers`, а видимость по агентам режется permissions.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "local-12600/qwen3.8",
  "mcp": {
    "servers": {
      // Каждая выгрузка — отдельный remote-сервер. Префикс ci_ против смешивания с другими MCP.
      "ci_ka2": {
        "type": "remote",
        "url": "http://127.0.0.1:8011/mcp",
        "oauth": false          // локальный сервер без авторизации — OAuth отключаем
      },
      "ci_erp": {
        "type": "remote",
        "url": "http://127.0.0.1:8012/mcp",
        "oauth": false
      },
      "ci_ktm": {
        "type": "remote",
        "url": "http://127.0.0.1:8013/mcp",
        "oauth": false
      },
      "ci_upp": {
        "type": "remote",
        "url": "http://127.0.0.1:8014/mcp",
        "oauth": false
      },
      "ci_obrabotki": {
        "type": "remote",
        "url": "http://127.0.0.1:8015/mcp",
        "oauth": false
      },
      "ci_erp_ext": {
        "type": "remote",
        "url": "http://127.0.0.1:8016/mcp",
        "oauth": false
      },
      "ci_ka_market_ext": {
        "type": "remote",
        "url": "http://127.0.0.1:8017/mcp",
        "oauth": false
      },
      "ci_ka_rs_ext": {
        "type": "remote",
        "url": "http://127.0.0.1:8018/mcp",
        "oauth": false
      },
      "ci_ka_td_ext": {
        "type": "remote",
        "url": "http://127.0.0.1:8019/mcp",
        "oauth": false
      }
    }
  },
  // ... providers и остальное без изменений
}
```

Примечания:

- `oauth: false` — обязательно, иначе OpenCode попытается пройти OAuth по умолчанию
  (документация: «Remote servers use OAuth by default»).
- Серверы подключаются автоматически; `disabled: true` — если нужно держать в конфиге,
  но не подключать.
- `codemode` по умолчанию `true` — оставляем (тулзы доступны через `execute`).
- Если сервер OpenCode работает в docker и ему нужен доступ к 127.0.0.1 хоста —
  подставить адрес хоста (например `http://host.docker.internal:8011/mcp` или IP).

### 3.2. Глобальный deny по умолчанию (опционально)

Если выгрузки должны быть видны **только** агентам, которым их явно назначили, —
запретить всё `ci_*` глобально и разрешать точечно:

```jsonc
{
  "permissions": [
    { "action": "ci_*", "resource": "*", "effect": "deny" }
  ]
}
```

Без этого правила все агенты по умолчанию видят все выгрузки (база — `allow *`).

## 4. Изоляция по агентам — `agents.<id>.permissions`

Правила: `{ action, resource, effect }`, **последнее совпадение побеждает**
(last match wins). Правила агента добавляются ПОСЛЕ глобальных (документация: permissions → «Agents»).

Action MCP-тулзы = нормализованное `<server>_<tool>`; для всех тулз одного сервера —
wildcard `ci_<алиас>_*` с `resource: "*"` (пример прямо из документации mcp-servers → «Permissions»).

> **Важно про подчёркивания.** Сервер называется `ci_ka2`, тулзы — `ci_ka2_get_function`
> (одно `_` между именем сервера и тулзы). Action-шаблон для ВСЕХ тулз сервера:
> **`ci_ka2_*`** (один подчёркивающий символ после алиаса, затем `*`).
> Написание `ci_ka2__*` (два `_`) совпадёт только с тулзами, чьё имя начинается с `_`,
> — такого нет.

### Пример: агент `ka2-dev` видит только KA2 + ERP_EXT

```jsonc
{
  "agents": {
    "ka2-dev": {
      "description": "Разработчик по базе КА2",
      "mode": "primary",
      "permissions": [
        // базовый запрет на все выгрузки (если глобального deny нет)
        { "action": "ci_*", "resource": "*", "effect": "deny" },
        // назначенные этому агенту выгрузки — точечно разрешаем
        { "action": "ci_ka2_*", "resource": "*", "effect": "allow" },
        { "action": "ci_erp_ext_*", "resource": "*", "effect": "allow" }
      ]
    }
  }
}
```

### Пример: агент `upp-qa` — только UPP

```jsonc
{
  "agents": {
    "upp-qa": {
      "permissions": [
        { "action": "ci_*", "resource": "*", "effect": "deny" },
        { "action": "ci_upp_*", "resource": "*", "effect": "allow" }
      ]
    }
  }
}
```

### Пример: агент без выгрузок (чистый)

```jsonc
{
  "agents": {
    "assistant": {
      "permissions": [
        { "action": "ci_*", "resource": "*", "effect": "deny" }
      ]
    }
  }
}
```

### Агенты в Markdown (frontmatter)

Frontmatter принимает те же поля, что и `agents.<id>` — permissions работают так же:

```md
---
description: Разработчик по базе КА2
mode: primary
permissions:
  - action: ci_*
    resource: "*"
    effect: deny
  - action: ci_ka2_*
    resource: "*"
    effect: allow
  - action: ci_erp_ext_*
    resource: "*"
    effect: allow
---

Ты работаешь с конфигурацией КА2. Для поиска по коду используй тулзы ci_ka2 (execute).
```

## 5. Что видит модель в Code Mode

При `codemode: true` (по умолчанию) разрешённые тулзы доступны как:

```js
tools.ci_ka2.get_function({ repo: "ka2", name: "..." })
tools.ci_ka2.search_function({ repo: "ka2", terms: ["Провести"] })
tools.ci_erp_ext.list_files({ repo: "erp_ext" })
```

Запрещённые серверы (deny) в списке тулз агента **отсутствуют** — модель их не видит.
Если у агента запрещены ВСЕ тулзы сервера, OpenCode также убирает его instructions из system prompt.

## 6. Запасной рычаг: плагин v2 (динамическая фильтрация)

Если статических permissions окажется недостаточно (например, нужно динамически менять
набор выгрузок на лету без перегенерации конфига), штатный механизм OpenCode 2.x —
плагин `Plugin.define` + хук `ctx.session.hook("context", ...)`: перед каждым вызовом
модели приходит событие с `event.tools`, из которого можно удалить тулзы.

Это **не** требуется для базовой схемы (permissions покрывают задачу). Плагин нужен только
для динамических сценариев.

## 7. Операционные команды

```bash
CI=/home/test/.config/ai-1c-server/code-index

# Индексация выгрузки (CLI, ~5–10 мин для крупной конфигурации)
$CI/reindex.sh <алиас> [--force]
# Пример: $CI/reindex.sh ka2 --force

# Проверка индекса (CLI, read-only)
CODE_INDEX_HOME=$CI $CI/bsl-indexer stats --path /mnt/zhvv_ai/workspace/KA2 | grep -E "Файлов|Функций"

# Статус serve'ов
for port in 8011 8012 8013 8014 8015 8016 8017 8018 8019; do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/mcp)
  echo "port $port: $code"   # 406 = работает
done

# Health демона (статус индексации всех каталогов)
curl -s http://127.0.0.1:8010/health | python3 -m json.tool
```

### Управление systemd-юнитами

```bash
# Статус всех сервисов code-index
systemctl --user status 'code-index-*'

# Логи конкретного serve'а
journalctl --user -u code-index-serve@ka2.service -f

# Рестарт одного serve'а
systemctl --user restart code-index-serve@ka2.service

# Рестарт демона индексации
systemctl --user restart code-index-daemon.service

# Остановить все
systemctl --user stop 'code-index-serve@*' code-index-daemon.service

# Запустить все
systemctl --user start code-index-daemon.service 'code-index-serve@*'
```

### Размеры индексов (на SMB, актуально на 2026-11-10)

| Алиас | Файлов | Функций | Размер БД |
|---|---|---|---|
| ka2 | 111,913 | 652,622 | 4.4 ГБ |
| erp | 52,026 | 220,551 | 3.5 ГБ |
| ktm | — | — | 3.3 ГБ |
| upp | 35,956 | 50,681 | 1.2 ГБ |
| obrabotki | 24,837 | — | 556 МБ (локально) |
| erp_ext | — | — | 19 МБ |
| ka_market_ext | — | — | 6.7 МБ |
| ka_rs_ext | — | — | 36 МБ |
| ka_td_ext | 324 | 643 | 12 МБ |

Всего: ~13 ГБ на SMB + 556 МБ локально (obrabotki).

## 8. Дальнейшие шаги

### Выполнено

- [x] Форк bsl-indexer v1.16.0-patched (WAL→OFF + `flush_to_disk` через /tmp)
- [x] Индексация всех 9 выгрузок (ка2, erp, ktm, upp, obrabotki, erp_ext, ka_market_ext, ka_rs_ext, ka_td_ext)
- [x] Индексы перенесены на SMB (~13 ГБ освобождено на локальном диске)
- [x] Serve'ы запущены (8011–8019), все отвечают 406
- [x] Записи MCP в агрегаторе (prod и dev): `code-index-<алиас>` → `http://127.0.0.1:80xx/mcp`
- [x] Живые проверки через агрегатор: `get_stats` на ka2/erp/upp — данные именно своей выгрузки
- [x] systemd user-юниты: `code-index-daemon.service` + `code-index-serve@.service` (9 инстансов)

### Не выполнено

1. **Генерация конфига админкой**: при генерации `opencode.jsonc` собирать
   `mcp.servers.ci_<алиас>` для выгрузок сервера и `agents.<id>.permissions`
   (deny `ci_*` + allow назначенные) — по данным из поля `code_indexes`.
