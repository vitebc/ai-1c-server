# Backend — ИИ-чат-агент для 1С

FastAPI-сервис: agent loop (function calling), RAG, MCP-клиент к 1С.

## Разработка

```bash
uv sync
uv run pytest
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run mypy src tests scripts/smoke_tools.py
uv run uvicorn app.main:app --reload --app-dir src
```

Конфигурация — через env (см. `src/app/config.py`), локально через файл `.env`
в корне репозитория. Пример всех переменных — `../.env.example`.

Ключевое для локального контура: `ONEC_MODE=mock|live` (моки или прокси
через `ONEC_MCP_URL` + опционально `ONEC_TOKEN`), прямые вызовы конкретных баз —
всегда live-JRPC в `{base_url}/hs/mcp/rpc` под `ONEC_USERNAME`/`ONEC_PASSWORD`
(+ `ONEC_BASES` для исключений). CORS открыт (`*`, `GET/POST/OPTIONS`) —
чат-форма 1С ходит из HTML-документа.

## Смоук function calling

Гоняет 31 вопрос на русском через петлю с мок-инструментами 1С, считает долю
попаданий в ожидаемый инструмент (критерий ≥ 0.9):

```bash
uv run python scripts/smoke_tools.py
```

Нужны рабочие `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` в `.env`.
Вопросы — в `scripts/questions.json` (`expected` — имя инструмента или `none`).

Базовый прогон 2026-09-13 (DeepSeek API, `deepseek-flash`, мок-инструменты):
completed 24/24, choice 24/24 = 1.00, clean 24/24 (без ERROR-ретраев).

Прогон 2026-09-13 после шага 2 (+RAG на fake-эмбеддингах, 7 KB-вопросов):
completed 31/31, choice 31/31 = 1.00, clean 31/31. Denial-тест прав
(профиль `sales` спрашивает про документ профиля `accounting`) — утечки нет,
модель честно отвечает «в базе знаний нет».

## Replay на живых данных 1С (без сети до базы)

```bash
uv run python scripts/smoke_tools.py --replay tests/fixtures/ka2_pilot.json
```

Фикстура — реальные ответы тестовой КА2 (сняты `onec/smoke_check.py`),
вопросы — `scripts/replay_questions.json`. Петля идёт через live-адаптер
(`build_onec_tools` + `FakeOnecClient`), LLM настоящий. Регресс шейпинга
и качества ответов после правок BSL.

Прогон 2026-09-13 (deepseek-flash): completed 6/6, choice 6/6 = 1.00.
Модель корректно отработала multi-match (5 стульев одной таблицей),
пустую карточку («не найден») и сложный кейс «долг Лебедева»:
5 поисков по карточке → пусто → отчёт debtors → долг найден.

## RAG-скелет (шаг 2)

```bash
uv run alembic upgrade head   # users/sessions(+base/skill/agent)/messages/documents(+agent)/chunks
```

Инжест синтетики (`synth_docs/`, профили прав — в `synth_docs/README.md`):

```bash
uv run python - <<'EOF'
import asyncio, sys
sys.path.insert(0, "src")
from pathlib import Path
from app.db.session import SessionFactory
from app.rag import FakeEmbeddings, ingest_file

async def main() -> None:
    for name, profile in {"vozvraty": "all", "sklad": "all", "otchety": "all",
                          "skidki": "sales", "kontragenty": "sales",
                          "debitorka": "accounting"}.items():
        await ingest_file(Path(f"synth_docs/{name}.md"), access_profile=profile,
                          session_factory=SessionFactory, embeddings=FakeEmbeddings())

asyncio.run(main())
EOF
```

Эмбеддинги: `EMBEDDINGS_PROVIDER` — `fake` (дефолт, детерминированные вектора:
честный тест plumbing'а retrieval, не качества поиска), `llamacpp`
(llama.cpp-server с OpenAI-совместимым `/v1/embeddings`, Qwen3-Embedding-4B,
2560 измерений, кириллица) или `tei` (`TEI_BASE_URL`, профиль `rag` в compose).

### Инжест папки документов

`scripts/ingest_kb.py` обходит каталог с `.md/.txt`, режет на чанки, эмбеддит
и кладёт в `documents`/`chunks`. Документ помечается `source='<collection>/<путь>'`,
поэтому `--replace` перезаписывает ровно свою коллекцию и не трогает чужое.

```bash
# dev (хост; DATABASE_URL из ../.env — порт 5435)
uv run python scripts/ingest_kb.py --dir /home/test/.config/ai-1c-server/kb/updinfo --collection updinfo --replace

# в контейнере (папка kb примонтирована в /app/kb)
docker compose exec backend uv run python scripts/ingest_kb.py \
  --dir /app/kb/updinfo --collection updinfo --replace
```

Ключи: `--profile` (access_profile, по умолчанию `all`), `--agent`
(agent_name для RAG-изоляции), `--batch-size`, `--limit`.

Коллекция — подпапка в корне корпуса (`<KB_DIR>/updinfo/`). В HTTP-API `/rag/reingest`
нет такой подпапки → 400: молчаливый переход в корень залил бы весь корпус.

Тот же корпус виден в админке: **AI Agent Studio → вкладка «База знаний»**
(состояние, список документов с предпросмотром чанков, пробный поиск, загрузка
документа, переинжест). Админка ходит в HTTP-API `/rag/*` бэкенда, поэтому
состояние БД и каталога не расходится.

Перед инжестом текст чистится от служебного мусора выгрузки its.1c.ru
(заголовок страницы, оглавление, битые ссылки на картинки), а чанк из одних
метаданных релиза отбрасывается.

Заголовок статьи (с номером версии) кладётся **отдельным служебным чанком**,
а не в каждый: номер версии есть только в заголовке, и без него запрос
«что нового в версии 2.6.1.64» находит соседние релизы. Служебный чанк
решает задачу, не размывая выдачу дубликатами заголовка (замер на корпусе
из 300 статей: top1 0.641 против 0.605 у варианта «заголовок в каждом чанке»,
разных статей в top-5 — 5/5 против 4/5).

Корпус лежит **вне репозитория** — `/home/test/.config/ai-1c-server/kb/`
(общий для dev и prod, примонтирован в контейнер как `/app/kb`, путь на хосте
задаётся `KB_HOST_DIR`). Обновляется скрапером `mcp/scraping_its`: скрипт
`scripts/sync_kb.sh` забирает свежие статьи и переинжестит их.

Запрос и документ эмбеддятся **асимметрично**: к запросу добавляется
instruct-префикс (задача поиска), документ — как есть. Префикс свой у каждой
задачи: `QUERY_INSTRUCTION` в `app/rag/retrieval.py` (поиск по базе знаний)
и `SKILL_INSTRUCTION` в `app/skills/loader.py` (подбор скила).

> **Почему асимметрично (замеры на реальной модели).** У Qwen3-Embedding
> косинус любых двух русских текстов ~0.4-0.6 — это фон, а не сходство.
> Симметричное сравнение (запрос↔описание без префикса) не разделяет
> «свой скил» и «шум»: зазор между ними — 0.003, рабочего порога нет.
> С instruct-префиксом под задачу зазор становится 0.014 и появляется
> рабочее окно порога.

> **Формулировка retrieval-префикса — нейтральная про домен, намеренно.**
> Вариант, называющий домен («…from 1C:Enterprise release notes»),
> подтягивает к любому запросу вектор в сторону корпуса: «мусорные» запросы
> поднимаются с 0.39 до 0.55, и порог отсечки перестаёт работать. Замеры
> по корпусу из 300 статей (hit@k — попадание в статью-владельца):
>
> | префикс | top1 | top5 | top10 | «мусор», макс. косинус |
> |---|---|---|---|---|
> | без префикса | 81/120 | 100/120 | 109/120 | 0.39 |
> | нейтральный | 82/120 | 104/120 | 113/120 | 0.50 |
> | с доменом | 77/120 | 104/120 | 109/120 | 0.55 |

### Пороги

Шкала косинуса зависит от модели, поэтому пороги по умолчанию — **по
провайдеру эмбеддингов**, а явное значение в `.env` их перекрывает:

| настройка | fake | llamacpp (Qwen3-Embedding-4B) | что делает |
|---|---|---|---|
| `SKILL_MATCH_THRESHOLD` | 0.30 | 0.65 | ниже — скил не применяется, модель работает полным набором тулзов |
| `KB_MIN_SCORE` | 0 (без отсечки) | 0.55 | ниже — «в базе знаний ничего не нашлось» |

При `llamacpp` порог скила 0.65 отсекает 100% шумовых запросов (погода,
рецепты) при 100% попаданий по релевантным; `KB_MIN_SCORE` 0.55 — то же
для поиска по базе знаний. Симметричное сравнение без префикса порога не
даёт вовсе (зазор 0.003).

Калибровать заново при смене модели: в лог чата пишутся score и top-3
кандидата авто-матчинга скила.

Чат: `POST /chat {message, session_id?, user_id?, attachments?[], context_size?, base_name?, base_url?, agent?, skill?}` — SSE (`tool`/`answer`/`done`),
история пишется в postgres. Мультибаза: с `base_url` — прямой JRPC в базу
(`JsonRpcOnecClient`), без — штатный путь (`mock`/прокси); резолв
`resolve_base_root` (мапа `ONEC_BASES` → присланный `base_url`), имя без адреса → `400`
без создания сессии. Профиль прав пользователя берётся из `users`
(`access_profile`, дефолт `all`). В `done`: `session_id/agent/skill/model/elapsed_s`,
токены (`prompt/completion/total`), `rounds/tool_errors`.

Петля: `agent_max_rounds` (дефолт 15, оверрайд `max_rounds` в `AGENT.md`)
+ предохранитель `agent_max_consecutive_errors` (дефолт 3 — стоп с честным
ответом вместо долбёжки упавшей 1С, `0` — выкл).

Агенты: `agents/<name>/AGENT.md` (формат — `agents/AGENT.md`): системный промпт
(ЗАМЕНЯЕТ базовый), фильтр `tools`, разрешённые `skills`, опциональный оверрайд
`model`, источники инструментов `mcp` (`default` + подсерверы агрегатора,
напр. `[default, search-ka-update, rlm]`). Выбор — явный `agent` из дропдауна 1С
(дефолт `assistant`), залипает в `sessions.agent_name`. `GET /agents` отдаёт список
для формы. Новый агент — новый файл, без рестарта. RAG изолирован по агенту
(`documents.agent_name`, NULL = общий).

Инструменты: `GET /tools` — живой реестр (имя/`server`/схема). Пулы: прокси 1С
(`default`: курируемые + динамические `a1c_Инструмент*` из `tools/list` прокси),
агрегатор (`AGG_MCP_URL`, тулзы `server__tool`, TTL-кэш `AGG_MCP_CACHE_TTL`,
падение агрегатора чат не роняет) и локальные (`search_knowledge_base`,
`get_pattern` — вне отбора по `mcp`).

> **Важно (dev):** `AGG_MCP_URL` должен указывать на **тот же** инстанс
> ai-1c-server, где добавляются MCP-серверы. Dev-стенд — порт **9225**
> (dev-БД), prod — **9224**. Если в `.env` прописан 9224, то серверы,
> добавленные в админке на dev (:9225), не появятся в `GET /tools` — их тулзы
> будут отсутствовать в реестре и в вкладке «Инструменты» редактора агента
> (в UI это выглядит как пустой/неполный список чекбоксов).
> Новый агрегатор подхватывается только после пересоздания контейнера
> (`docker compose up -d --force-recreate backend`) — не хватает `restart`,
> он не перечитывает `.env`.

Скилы: `skills/<name>/SKILL.md` (формат — `skills/SKILL.md`). Бэкенд фильтрует
реестр по `tools` скила и дописывает его промпт; выбор — всегда авто-матчинг
по `description` среди скилов агента (форма 1С поле `skill` не шлёт),
top-1 только при score ≥ `skill_match_threshold` (дефолт 0.3; ниже — полный
набор тулзов агента, score пишется в лог для калибровки).
Новый сценарий — новый файл, без рестарта.

Паттерны: `patterns/<name>.md` (формат — `patterns/README.md`). Ленивая
подгрузка моделью через тулзу `get_pattern({"name": "..."})` в момент нужды
(перед первым `execute_select`); в промпте агентов только указатель.
Новый паттерн — новый файл, без рестарта.

DB-тесты (`test_rag_db.py`, `test_chat_api.py`) требуют поднятый postgres.

## Отложено (нет реальных документов/трафика)

- Docling (PDF/DOCX): инжест сейчас только `.md`/`.txt`; PDF поднимет ошибку
  с подсказкой. Тянуть torch ради синтетики не стали.
- Живой TEI: образ и модель (~3 ГБ) качаем, когда появятся реальные документы.
- Langfuse: трейсинг подключаем, когда будет реальный трафик (шаг 3–4).
