"""Бюджет контекста: оценка размера промпта и сворачивание старых результатов.

Живой случай (2026-10-27, прод): вопрос «покажи продажи Ассоль за 2025 год»,
агент `assistant` — 14 раундов, 28 результатов инструментов на 91 572 символа
(один `get_metadata_tree` — 20 000), плюс 128 схем инструментов. Итог —
запрос на 64 342 токена при окне модели 64 256, LLM ответила 400
`exceed_context_size_error`, и чат упал с ошибкой вместо ответа.

Здесь два независимых средства, оба дешёвые:
- `truncate_tool_result` — один результат не бывает больше лимита;
- `shrink_messages` — старые результаты сворачиваются в короткую заглушку,
  последние (`KEEP_FULL_TOOL_RESULTS`) остаются целыми целиком.

Оценка токенов намеренно грубая и сверху: живой замер дал ~3.5 символа на
токен (JSON схемы + кириллица), берём 3 — сворачивание включится раньше,
чем модель упрётся в окно.
"""

from __future__ import annotations

from typing import Any

#: Символов на токен (см. докстринг модуля — консервативно).
CHARS_PER_TOKEN = 3

#: Бюджет промпта по умолчанию (токены). Окно прод-модели — 64 256, оставляем
#: запас на ответ и разброс оценки.
DEFAULT_CONTEXT_BUDGET_TOKENS = 60000

#: Сколько последних результатов инструментов не трогаем при сворачивании:
#: именно они нужны модели для текущего шага.
KEEP_FULL_TOOL_RESULTS = 2

#: Потолок одного результата инструмента в контексте (символы).
MAX_TOOL_RESULT_CHARS = 8000

#: Сколько символов начала оставляем от свёрнутого результата.
STUB_CHARS = 300

#: Начало заглушки: по нему же узнаём уже свёрнутый результат (идемпотентность).
SHRUNK_PREFIX = "[свёрнуто из-за размера контекста"


def truncate_tool_result(text: str, limit: int = MAX_TOOL_RESULT_CHARS) -> str:
    """Обрезать один результат инструмента до лимита с пометкой для модели.

    Режем хвост: в результатах 1С и поиска по коду важное (ошибка, шапка
    таблицы, первые строки) — в начале. Пометка говорит модели, что данные
    неполные, и подсказывает, как получить остальное, — иначе она считает
    обрезанный список исчерпывающим.
    """
    if limit <= 0 or len(text) <= limit:
        return text
    shown = text[:limit]
    return (
        f"{shown}\n…[результат обрезан: было {len(text)} символов, показано {limit}. "
        "Данные неполные — уточните запрос (фильтр, период, limit) или запросите "
        "конкретный объект/строку, а не весь список]"
    )


def estimate_tokens(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    chars_per_token: int = CHARS_PER_TOKEN,
) -> int:
    """Приблизительный размер промпта в токенах (схемы инструментов + сообщения)."""
    chars = 0
    for msg in messages:
        chars += _content_chars(msg.get("content"))
        # tool_calls ассистента (имя + JSON аргументов) тоже уходят в промпт
        for call in msg.get("tool_calls") or []:
            if isinstance(call, dict):
                fn = call.get("function") or {}
                chars += len(str(fn.get("name", ""))) + len(str(fn.get("arguments", "")))
    if tools:
        for schema in tools:
            chars += _content_chars(schema)
    return chars // max(1, chars_per_token)


def shrink_messages(
    messages: list[dict[str, Any]],
    *,
    budget_tokens: int,
    tools: list[dict[str, Any]] | None = None,
    keep_full: int = KEEP_FULL_TOOL_RESULTS,
    stub_chars: int = STUB_CHARS,
) -> int:
    """Свернуть самые старые результаты инструментов, пока промпт не влезет.

    Правка на месте (петля дописывает в тот же список). Возвращает число
    свёрнутых сообщений: 0 — уже влезало или сворачивать нечего.
    """
    if budget_tokens <= 0:
        return 0
    tool_idx = [
        i for i, msg in enumerate(messages) if msg.get("role") == "tool" and isinstance(msg.get("content"), str)
    ]
    protect = set(tool_idx[-keep_full:]) if keep_full > 0 else set()
    shrunk = 0
    for i in tool_idx:
        if estimate_tokens(messages, tools) <= budget_tokens:
            break
        if i in protect:
            continue
        content = messages[i]["content"]
        if content.startswith(SHRUNK_PREFIX):
            continue
        messages[i]["content"] = (
            f"{SHRUNK_PREFIX}: было {len(content)} символов, оставлено начало]\n{content[:stub_chars]}…"
        )
        shrunk += 1
    return shrunk


def compact_history(
    contents: list[str],
    *,
    message_chars: int = 4000,
    total_chars: int = 20000,
) -> list[str]:
    """Сжать историю диалога до бюджета, сохранив самые свежие сообщения.

    История берётся по числу сообщений (40), но каждое могло быть на 20 000
    символов — тогда она одна съедает всё окно. Режем каждое сообщение и
    отбрасываем старые, пока сумма не влезет; последнее оставляем всегда.
    """
    trimmed = [c if len(c) <= message_chars else c[:message_chars] + "…[сообщение обрезано]" for c in contents]
    kept: list[str] = []
    total = 0
    for text in reversed(trimmed):
        if kept and total + len(text) > total_chars:
            break
        kept.append(text)
        total += len(text)
    kept.reverse()
    return kept


def _content_chars(content: Any) -> int:
    """Размер content в символах: строка, multimodal-список или None."""
    if content is None:
        return 0
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        total = 0
        for part in content:
            if isinstance(part, dict):
                if part.get("type") == "text":
                    total += len(str(part.get("text", "")))
                elif part.get("type") == "image_url":
                    # Картинка уходит отдельным тензором, base64 в промпт не идёт
                    total += 1000
            elif isinstance(part, str):
                total += len(part)
        return total
    return len(str(content))
