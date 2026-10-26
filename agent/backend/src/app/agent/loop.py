"""Тонкая агентская петля с function calling.

Правила (см. AGENTS.md, «Схема запросов»):
- модель выбирает только из готовых инструментов, сырой язык запросов 1С запрещён;
- аргументы валидируются pydantic-схемой инструмента;
- ошибка инструмента возвращается модели как tool result — она чинит параметры
  и повторяет вызов;
- неизвестный инструмент — тоже ошибка в контекст, а не падение;
- предохранитель: N ошибок подряд (max_consecutive_errors, 0 — выкл) останавливают
  петлю с честным ответом про недоступность 1С вместо долбёжки упавшего шлюза.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from app.agent.tools import ToolContext, ToolRegistry
from app.llm import AssistantMessage, ChatLLM

log = logging.getLogger("agent1c.loop")

SYSTEM_PROMPT = (
    "Ты — ассистент пользователей 1С, отвечаешь на русском языке.\n"
    "Данные берёшь ТОЛЬКО из инструментов. Приоритет:\n"
    "1) готовые: get_stock_balance, get_counterparty, run_skd_report — если вопрос про них;\n"
    "2) для любых других данных 1С (документы ЗаказКлиента, Реализация и т.п., "
    "справочники, регистры) — используй execute_select: сначала уточни имена через "
    "list_metadata_objects/get_metadata_structure, затем сформируй ВЫБРАТЬ запрос "
    "и проверь через validate_query.\n"
    "Не выдумывай имена объектов — сверяй через инструменты метаданных. "
    "Если после проверки данных нет — так и скажи.\n"
    "В execute_select параметры (&q) НЕ поддерживаются — подставляй значения литералами "
    "в текст запроса, спецсимволы ПОДОБНО (%, _) экранируй как [%] и [_].\n"
    "Поиск по контрагентам/номенклатуре — нечёткий: разбивай фразу на слова и ищи "
    "ПОДОБНО %слово% по Наименование/НаименованиеПолное, период для заказов не обязателен — "
    "по умолчанию последние 5 по Дата УБЫВ.\n"
    "Если инструмент вернул matches (несколько кандидатов) — покажи их пользователю и спроси, "
    "кого он имел в виду. Запрещено молча выбирать одного кандидата и выдавать его за ответ.\n"
    "Уточняющий вопрос (оставь, убери, отсортируй, покажи детали, посчитай итог) относится "
    "к строкам прошлого ответа из истории диалога — фильтруй/считай по ним, новый широкий "
    "поиск не начинай. Не хватает поля (сумма, статус) — добери его одним точечным "
    "execute_select по уже известным ключам (Номер), а не повторной разведкой.\n"
    "Табличные данные оформляй markdown-таблицей, цифры — как вернулось из инструмента.\n"
    "Если инструмент вернул ERROR — исправь параметры и повтори вызов, не сдавайся сразу.\n"
    "Запрещено выдумывать результаты инструментов: совпадения поиска, имена файлов, номера строк, "
    "значения полей. Если ты не вызвал инструмент в этом диалоге — у тебя НЕТ данных о его результате; "
    "скажи, что поиск не выполнен, и предложи вызвать инструменты."
)


@dataclass
class RoundStep:
    """Один шаг петли для записи в agent_rounds (просмотр в админке).

    role: "assistant" — ответ LLM (content + вызовы), "tool" — результат
    инструмента (tool_name/tool_args обязательны, content — feedback).
    """

    round_no: int
    step: int
    role: str
    content: str = ""
    tool_name: str | None = None
    tool_args: dict[str, Any] | None = None
    is_error: bool = False


@dataclass
class AgentResult:
    answer: str
    rounds: int
    tool_calls: list[str] = field(default_factory=list)
    # Шаги петли (раунды + вызовы инструментов) для записи в agent_rounds.
    round_steps: list[RoundStep] = field(default_factory=list)
    # Сколько раз модели вернули ERROR-фидбэк (невалидные аргументы, неизвестный
    # инструмент, падение обработчика). 0 = чисто с первой попытки.
    tool_errors: int = 0
    # Сумма usage по всем раундам (шаги без usage от провайдера дают нули).
    prompt_tokens: int = 0
    completion_tokens: int = 0


def _preview(content: str | list[dict[str, Any]] | None, limit: int = 500) -> str:
    """Короткий текст для логов: data URI выкидываем, пробелы жмём, режем."""
    if not isinstance(content, str):
        chunks = []
        for part in content or []:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                chunks.append(str(part.get("text", "")))
            elif part.get("type") == "image_url":
                chunks.append("[image]")
        content = " ".join(chunks)
    text = " ".join(content.split())
    return text if len(text) <= limit else text[:limit] + "…"


def _assistant_message(msg: AssistantMessage) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": msg.content,
        "tool_calls": [
            {
                "id": c.id,
                "type": "function",
                "function": {"name": c.name, "arguments": c.arguments},
            }
            for c in msg.tool_calls
        ],
    }


def _full_assistant_text(msg: AssistantMessage) -> str:
    """Полный текст assistant-сообщения для логов: контент + tool_calls без обрезки."""
    content = msg.content
    if isinstance(content, list):
        parts = [str(p.get("text", "")) for p in content if isinstance(p, dict) and p.get("type") == "text"]
        content = " ".join(parts)
    text = content or ""
    calls = "; ".join(f"{c.name}({c.arguments})" for c in msg.tool_calls)
    return f"{text}\nTOOL_CALLS: {calls}" if calls else text


def _assistant_text(content: str | list[dict[str, Any]] | None) -> str:
    """Текст assistant-шага (content может быть multimodal-списком)."""
    if isinstance(content, list):
        return " ".join(str(p.get("text", "")) for p in content if isinstance(p, dict) and p.get("type") == "text")
    return content or ""


def _args_dict(arguments: str) -> dict[str, Any] | None:
    """Аргументы tool call как JSON-объект (сырой текст — в строку)."""
    try:
        parsed = json.loads(arguments)
        return parsed if isinstance(parsed, dict) else {"raw": arguments}
    except ValueError:
        return {"raw": str(arguments)}


async def _finish_with_final_answer(
    *,
    llm: ChatLLM,
    messages: list[dict[str, Any]],
    why: str,
    fallback: str,
    called: list[str],
    errors: int,
    prompt_tokens: int,
    completion_tokens: int,
    round_steps: list[RoundStep] | None = None,
) -> AgentResult:
    """Предохранитель сработал: дать модели ОДИН шанс ответить из того, что уже есть.

    Живой случай: агент нашёл вхождение в раунде 7 и прочитал контекст в раунде 13,
    но продолжал перебор до стопа — и пользователь вместо ответа получал тишину
    про инструмент. Здесь инструменты отключены (пустой список схем), поэтому
    модель обязана сформулировать текст, а не звать тулзы снова.

    Если модель всё равно молчит или сама просит ещё данных — отдаём fallback.
    """
    final_messages = [
        *messages,
        {
            "role": "user",
            "content": (
                f"Стоп: {why}. Инструменты больше недоступны — новых вызовов не будет.\n\n"
                "Ответь пользователю СЕЙЧАС, опираясь только на то, что уже нашёл в диалоге. "
                "Если что-то нашёл — расскажи это своими словами и честно скажи, чего не хватило. "
                "Если ничего не нашёл — так и напиши и предложи, что уточнить. "
                "Не предлагай новых поисков и не вызывай инструменты."
            ),
        },
    ]
    steps = list(round_steps or [])
    final_round = max([st.round_no for st in steps], default=0) + 1
    try:
        resp = await llm.complete(final_messages, [])
    except Exception as e:  # noqa: BLE001 — LLM упал: отдаём заготовку, петлю не роняем
        log.warning("финальный ответ не удался (%s), отдаю заготовку", e)
        return AgentResult(
            answer=fallback,
            rounds=len(called),
            tool_calls=called,
            tool_errors=errors,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            round_steps=steps,
        )
    if resp.usage is not None:
        prompt_tokens += resp.usage.prompt_tokens
        completion_tokens += resp.usage.completion_tokens
    text = (resp.content or "").strip()
    log.info(
        "предохранитель сработал (%s); финальный ответ от модели: %s",
        why,
        _preview(text, 200) or "(пусто)",
    )
    if not text or text.startswith(("Стоп:", "Я не могу вызвать")):
        text = fallback
    steps.append(RoundStep(round_no=final_round, step=1, role="assistant", content=text))
    return AgentResult(
        answer=text,
        rounds=len(called),
        tool_calls=called,
        tool_errors=errors,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        round_steps=steps,
    )


async def run_agent(
    *,
    llm: ChatLLM,
    registry: ToolRegistry,
    user_message: str | list[dict[str, Any]] = "",
    user_id: str = "dev",
    access_profile: str = "all",
    base_name: str = "",
    max_rounds: int = 6,
    history: list[dict[str, Any]] | None = None,
    extra_system: str = "",
    skill_name: str = "",
    base_system: str = SYSTEM_PROMPT,
    agent_name: str = "",
    base_url: str = "",
    max_consecutive_errors: int = 3,
    max_repeat_calls: int = 3,
) -> AgentResult:
    """Агентская петля: LLM -> вызовы инструментов -> ... -> финальный ответ.

    max_consecutive_errors — стоп после N ошибок инструментов подряд (0 = выкл).
    max_repeat_calls — стоп после N одинаковых вызовов одного инструмента с одними
    и теми же аргументами (0 = выкл). Ловит бесполезный перебор вариантов запроса,
    когда инструмент честно отвечает «ничего не найдено» и ошибкой это не считается
    (живой случай: search_files × 23 одинаковыми аргументами до лимита раундов).
    """
    system = base_system + ("\n\n" + extra_system.strip() if extra_system.strip() else "")
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
    ]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_message})
    ctx = ToolContext(
        user_id=user_id,
        access_profile=access_profile,
        base_name=base_name,
        agent_name=agent_name,
        base_url=base_url,
    )
    called: list[str] = []
    errors = 0
    consec_errors = 0
    last_error = ""
    # Счётчик повторов: (инструмент, аргументы) -> сколько раз подряд звали одинаково.
    # Ключ нормализован пробелами, чтобы "ВС11 " и " ВС11" не считались разными.
    repeat_calls: dict[tuple[str, str], int] = {}
    last_repeat_key: tuple[str, str] | None = None
    # Серия пустых ответов одного инструмента (аргументы могут отличаться).
    consec_empty = 0
    last_empty_tool = ""
    # Инструменты, для которых уже вставлена подсказка про неоднозначный поиск.
    ambiguous_tools: set[str] = set()
    prompt_tokens = 0
    completion_tokens = 0
    # Шаги петли для записи в agent_rounds (просмотр раундов в админке).
    round_steps: list[RoundStep] = []
    started = time.monotonic()
    base = base_name or "-"
    skill = skill_name or "-"
    agent = agent_name or "-"
    log.info("user=%s base=%s agent=%s skill=%s q=%s", user_id, base, agent, skill, _preview(user_message))

    for round_no in range(1, max_rounds + 1):
        resp = await llm.complete(messages, registry.schemas())
        if resp.usage is not None:
            prompt_tokens += resp.usage.prompt_tokens
            completion_tokens += resp.usage.completion_tokens
        messages.append(_assistant_message(resp))
        log.info("user=%s round=%d assistant: %s", user_id, round_no, _full_assistant_text(resp))
        # Шаг LLM в трасс: текст + вызовы инструментов (аргументы) — для админки.
        step_calls = "; ".join(f"{c.name}({_preview(c.arguments, 300)})" for c in resp.tool_calls)
        step_content = _assistant_text(resp.content).strip()
        if step_calls:
            step_content = f"{step_content}\nTOOL_CALLS: {step_calls}".strip()
        round_steps.append(RoundStep(round_no=round_no, step=1, role="assistant", content=step_content))
        if not resp.tool_calls:
            elapsed = time.monotonic() - started
            log.info(
                "user=%s base=%s agent=%s skill=%s rounds=%d tools=%s errors=%d elapsed=%.1fs answered: %s",
                user_id,
                base,
                agent,
                skill,
                round_no,
                called,
                errors,
                elapsed,
                _preview(resp.content, 100_000),
            )
            return AgentResult(
                answer=resp.content or "",
                rounds=len(called) + 1,
                tool_calls=called,
                tool_errors=errors,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                round_steps=round_steps,
            )
        for call in resp.tool_calls:
            called.append(call.name)
            feedback = await _execute_call(registry, ctx, call.name, call.arguments)
            # Нормализуем кавычки: 1С иногда возвращает ошибку уже JSON-закодированной ("Ошибка...").
            if feedback.lstrip(' \t"\u201c').startswith(("ERROR", "Ошибка выполнения", "Ошибка:")):
                errors += 1
                consec_errors += 1
                last_error = feedback
            else:
                consec_errors = 0
            # Предохранитель повторов: тот же инструмент с теми же аргументами
            # N раз подряд — модель зациклилась (часто «ничего не найдено»).
            if consec_errors == 0:
                repeat_key = (call.name, _norm_args(call.arguments))
                if repeat_key == last_repeat_key:
                    repeat_calls[repeat_key] = repeat_calls.get(repeat_key, 1) + 1
                else:
                    repeat_calls[repeat_key] = 1
                last_repeat_key = repeat_key
            else:
                last_repeat_key = None
            # Предохранитель пустых ответов: тот же инструмент N раз подряд вернул
            # «ничего не найдено», даже если аргументы слегка менялись (пробелы,
            # head_limit, лишние фильтры) — перебор вариантов запроса вслепую.
            if consec_errors == 0:
                if call.name == last_empty_tool and _is_empty_result(feedback):
                    consec_empty += 1
                else:
                    consec_empty = 1 if _is_empty_result(feedback) else 0
                last_empty_tool = call.name
            else:
                consec_empty = 0
                last_empty_tool = call.name
            log.info(
                "user=%s round=%d tool=%s args=%s -> %s",
                user_id,
                round_no,
                call.name,
                call.arguments,
                feedback,
            )
            # Ответ инструмента в трасс: имя + аргументы + результат (результат —
            # компактный, как в 1С; data-URI не попадают сюда).
            round_steps.append(
                RoundStep(
                    round_no=round_no,
                    step=len(resp.tool_calls) + 2,
                    role="tool",
                    tool_name=call.name,
                    tool_args=_args_dict(call.arguments),
                    content=feedback,
                    is_error=consec_errors > 0,
                )
            )
            messages.append({"role": "tool", "tool_call_id": call.id, "content": feedback})
            # Неоднозначный поиск: файл из разных корневых папок (объектов) —
            # механическая страховка от «молча ковал оба». Промпт агента уже
            # требует уточнить, но слабая модель его игнорирует; подсказка в
            # контексте сильнее. Один раз на объект: повторный inject при каждом
            # поиске только шумит (модель и так видит оба результата).
            if consec_errors == 0:
                roots = _ambiguous_objects(feedback)
                if roots is not None and call.name not in ambiguous_tools:
                    ambiguous_tools.add(call.name)
                    hint = (
                        "ВНИМАНИЕ: поиск нашёл файлы из разных объектов/выгрузок: "
                        + ", ".join(roots)
                        + ". Прежде чем читать код, задай пользователю ОДИН уточняющий "
                        "вопрос — какой именно объект (база/папка) имеется в виду. "
                        "Определять «где есть нужная колонка» самостоятельно нельзя: "
                        "одинаковый заголовок может быть в обоих макетах."
                    )
                    messages.append({"role": "system", "content": hint})
                    log.info(
                        "user=%s round=%d ambiguous objects in %s result: %s — injected clarification hint",
                        user_id,
                        round_no,
                        call.name,
                        ", ".join(roots),
                    )
            # Проверяем повтор только пока остались раунды: если раунды всё равно
            # кончились, честнее сказать про лимит раундов, а не про повтор.
            rounds_left = round_no < max_rounds
            # Сначала повтор одного и того же вызова, затем — серия пустых ответов.
            # Оба срабатывают, только пока остались раунды: если раунды всё равно
            # кончились, честнее сказать про лимит раундов.
            if rounds_left and consec_errors == 0 and 0 < max_repeat_calls <= consec_empty:
                log.warning(
                    "user=%s base=%s agent=%s skill=%s пустых ответов: %s вернул «не найдено» %d раз подряд, стоп",
                    user_id,
                    base,
                    agent,
                    skill,
                    call.name,
                    consec_empty,
                )
                return await _finish_with_final_answer(
                    llm=llm,
                    messages=messages,
                    why=(
                        f"инструмент {call.name} {consec_empty} раз подряд вернул «ничего не найдено» "
                        f"(последний ответ: {_preview(feedback, 300)}). Похоже, выбранный инструмент "
                        "не подходит для этой задачи — например, поиск по имени файла не видит "
                        "объекты, описанные только в XML"
                    ),
                    fallback=(
                        "Автоматический поиск не дал результата: инструмент несколько раз подряд "
                        "не нашёл ничего подходящего. Уточните объект или поищите по другому признаку."
                    ),
                    called=called,
                    errors=errors,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    round_steps=round_steps,
                )
            if rounds_left and consec_errors == 0 and 0 < max_repeat_calls <= repeat_calls[repeat_key]:
                log.warning(
                    "user=%s base=%s agent=%s skill=%s повтор: %s %s вызван %d раз подряд с одними аргументами, стоп",
                    user_id,
                    base,
                    agent,
                    skill,
                    call.name,
                    _preview(repeat_key[1], 200),
                    repeat_calls[repeat_key],
                )
                return await _finish_with_final_answer(
                    llm=llm,
                    messages=messages,
                    why=(
                        f"инструмент {call.name} уже {repeat_calls[repeat_key]} раз вызван с одними и теми же "
                        f"аргументами ({_preview(repeat_key[1], 200)}) и вернул то же самое"
                    ),
                    fallback=(
                        "Автоматический поиск зациклился на одинаковых вызовах и не дал результата. "
                        "Уточните объект или поищите по другому признаку."
                    ),
                    called=called,
                    errors=errors,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    round_steps=round_steps,
                )
            if 0 < max_consecutive_errors <= consec_errors:
                log.warning(
                    "user=%s base=%s agent=%s skill=%s circuit breaker: %d ошибок подряд, стоп: %s",
                    user_id,
                    base,
                    agent,
                    skill,
                    consec_errors,
                    _preview(last_error),
                )
                return AgentResult(
                    answer=(
                        "Не получается обратиться к базе 1С — инструменты несколько раз подряд "
                        f"вернули ошибку (последняя: {_preview(last_error, 300)}). "
                        "Это проблема на стороне подключения/сервера, а не формулировки запроса: "
                        "проверьте доступность базы и MCP-шлюза, затем повторите вопрос."
                    ),
                    rounds=len(called),
                    tool_calls=called,
                    tool_errors=errors,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    round_steps=round_steps,
                )

    log.warning(
        "user=%s base=%s agent=%s skill=%s rounds exhausted: tools=%s errors=%d elapsed=%.1fs",
        user_id,
        base,
        agent,
        skill,
        called,
        errors,
        time.monotonic() - started,
    )
    return AgentResult(
        answer="Не уложился в лимит раундов диалога с инструментами. Попробуйте уточнить вопрос.",
        rounds=max_rounds,
        tool_calls=called,
        tool_errors=errors,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        round_steps=round_steps,
    )


#: Ответы инструментов, которые означают «ничего не нашлось» (не ошибка!).
#: Список короткий и явный: эвристика по тексту, а не универсальный разбор JSON.
#: Остережение: «0 файлов»/«0 результатов» проверяются как число — иначе маркер
#: ловит подстроку в «Найдено 20 файлов» и успевает оборвать рабочий поиск.
_EMPTY_MARKERS = (
    "найдено 0",
    "0 найдено",
    "не найдено",
    "ничего не найдено",
    "нет результатов",
    "пустой результат",
    "0 записей",
)

_FILES_COUNT_RE = re.compile(r"найдено\s+(\d+)\s+файлов?", re.IGNORECASE)
#: Пути в результатах поиска: `- `ТП601 УПП/ТП603 ПС/...`` или голый `папка/файл.bsl`.
_PATH_LINE_RE = re.compile(r"^\s*(?:[-*•]\s*)?`?([A-Za-zА-Яа-яЁё][\w .\-]*?/[A-Za-zА-Яа-яЁё][^`\n]*)`?\s*$")


def _is_empty_result(feedback: str) -> bool:
    """Похоже ли, что инструмент ответил «ничего не нашлось» (а не сломался)."""
    head = feedback[:400].lower()
    # «Найдено 0 файлов» — реальный ноль. «Найдено 20 файлов» — успех, хотя в
    # тексте есть подстрока «0 файлов» (из «20»); поэтому проверяем число.
    m = _FILES_COUNT_RE.search(head)
    if m:
        return int(m.group(1)) == 0
    return any(marker in head for marker in _EMPTY_MARKERS)


def _ambiguous_objects(feedback: str) -> list[str] | None:
    """Найдено ли несколько файлов из разных корневых папок (объектов).

    Живой случай (ПС44): `search_files` вернул 8 файлов, среди них два объекта
    с одинаковым именем в разных папках («ТП601 КА ТД/…» и «ТП601 УПП/…»).
    Модель не уточнила у пользователя, какой нужен, и ковала оба — до лимита
    раундов. Возвращает список корневых папок (для подсказки) или None.
    """
    paths: list[str] = []
    for line in feedback.splitlines():
        m = _PATH_LINE_RE.match(line)
        if m:
            paths.append(m.group(1).strip().rstrip("`").strip())
    # Корневая папка — первая компонента пути (в индексе это корень выгрузки:
    # «ТП601 УПП», «ТП601 КА ТД»). Разные корни = разные объекты/выгрузки.
    roots = {p.split("/", 1)[0] for p in paths if "/" in p}
    return sorted(roots) if len(roots) >= 2 else None


def _norm_args(arguments: Any) -> str:
    """Канонический вид аргументов для сравнения повторов.

    Модель может отличаться только пробелами/порядком ключей (`{"a": 1}` против
    `{"a":1}`), и это тот же самый вызов. Поэтому сначала пробуем JSON с
    отсортированными ключами, а при неудаче — просто схлопываем пробелы.
    """
    raw = str(arguments or "")
    try:
        return json.dumps(json.loads(raw), sort_keys=True, ensure_ascii=False)
    except ValueError:
        return " ".join(raw.split())


async def _execute_call(registry: ToolRegistry, ctx: ToolContext, name: str, arguments: str) -> str:
    tool = registry.get(name)
    if tool is None:
        return f"ERROR: неизвестный инструмент '{name}'. Доступны: {registry.names}. Выбери из них."
    try:
        args = tool.args_model.model_validate_json(arguments)
    except ValidationError as e:
        return f"ERROR: невалидные аргументы для '{name}': {e}. Исправь параметры и повтори вызов."
    try:
        return await tool.handler(args, ctx)
    except Exception as e:  # обработчик не должен ронять петлю
        return f"ERROR: инструмент '{name}' завершился ошибкой: {e}. Попробуй изменить параметры."
