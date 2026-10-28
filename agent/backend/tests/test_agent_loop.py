"""Тесты агентской петли с фейковым LLM — сеть не нужна."""

from __future__ import annotations

import asyncio

from app.agent import AgentResult, ToolRegistry, run_agent
from app.llm import AssistantMessage, ToolCall
from app.tools import MOCK_ONEC_TOOLS
from tests.fake_llm import FakeLLM


def _run(llm: FakeLLM, question: str = "тест", max_rounds: int = 6) -> AgentResult:
    return asyncio.run(
        run_agent(
            llm=llm,
            registry=ToolRegistry(MOCK_ONEC_TOOLS),
            user_message=question,
            max_rounds=max_rounds,
        )
    )


def test_answer_without_tools() -> None:
    llm = FakeLLM([AssistantMessage(content="Привет!")])
    res = _run(llm, "привет")
    assert res.answer == "Привет!"
    assert res.tool_calls == []
    assert res.rounds == 1


def test_single_tool_round_trip() -> None:
    llm = FakeLLM(
        [
            AssistantMessage(
                content=None,
                tool_calls=[ToolCall(id="c1", name="get_stock_balance", arguments='{"sku": "стул"}')],
            ),
            AssistantMessage(content="Остаток: 42+7."),
        ]
    )
    res = _run(llm, "сколько стульев?")
    assert res.tool_calls == ["get_stock_balance"]
    assert "42" in res.answer
    # tool result попал в контекст второго шага
    tool_msgs = [m for m in llm.seen_messages[1] if m.get("role") == "tool"]
    assert len(tool_msgs) == 1 and "Основной" in str(tool_msgs[0]["content"])


def test_invalid_args_then_retry() -> None:
    llm = FakeLLM(
        [
            AssistantMessage(
                content=None,
                tool_calls=[ToolCall(id="c1", name="get_stock_balance", arguments='{"sku": "x"}')],
            ),
            AssistantMessage(
                content=None,
                tool_calls=[ToolCall(id="c2", name="get_stock_balance", arguments='{"sku": "стул офисный"}')],
            ),
            AssistantMessage(content="Готово."),
        ]
    )
    res = _run(llm, "остатки?")
    assert res.answer == "Готово."
    assert res.tool_calls == ["get_stock_balance", "get_stock_balance"]
    feedback = str(llm.seen_messages[1][-1]["content"])
    assert "ERROR" in feedback and "невалидные аргументы" in feedback


def test_unknown_tool_reported_to_model() -> None:
    llm = FakeLLM(
        [
            AssistantMessage(
                content=None,
                tool_calls=[ToolCall(id="c1", name="teleport", arguments="{}")],
            ),
            AssistantMessage(content="Такого инструмента нет."),
        ]
    )
    res = _run(llm, "телепортируй")
    assert res.answer == "Такого инструмента нет."
    feedback = str(llm.seen_messages[1][-1]["content"])
    assert "неизвестный инструмент" in feedback


def test_max_rounds_guard() -> None:
    script = [
        AssistantMessage(
            content=None,
            tool_calls=[ToolCall(id=f"c{i}", name="get_stock_balance", arguments='{"sku": "стул"}')],
        )
        for i in range(10)
    ]
    llm = FakeLLM(script)
    res = _run(llm, "зацикли меня", max_rounds=3)
    assert res.rounds == 3
    assert res.tool_calls == ["get_stock_balance"] * 3
    assert "лимит раундов" in res.answer


def test_registry_schemas() -> None:
    reg = ToolRegistry(MOCK_ONEC_TOOLS)
    assert set(reg.names) >= {"get_counterparty", "get_stock_balance", "run_skd_report"}
    assert {s["function"]["name"] for s in reg.schemas()} == set(reg.names)
    assert reg.get("nope") is None
    assert "get_metadata_tree" in reg.names
    assert "execute_query" in reg.names
    assert "get_configuration_info" in reg.names


def _run_with_breaker(llm: FakeLLM, max_consecutive_errors: int, max_rounds: int = 15) -> AgentResult:
    return asyncio.run(
        run_agent(
            llm=llm,
            registry=ToolRegistry(MOCK_ONEC_TOOLS),
            user_message="тест",
            max_rounds=max_rounds,
            max_consecutive_errors=max_consecutive_errors,
        )
    )


def _fail_script(n: int, name: str = "teleport") -> list[AssistantMessage]:
    # Неизвестный инструмент -> каждый вызов заканчивается ERROR-фидбэком.
    return [
        AssistantMessage(content=None, tool_calls=[ToolCall(id=f"c{i}", name=name, arguments="{}")]) for i in range(n)
    ]


def test_circuit_breaker_stops_death_spiral() -> None:
    llm = FakeLLM(_fail_script(10))
    res = _run_with_breaker(llm, max_consecutive_errors=3)
    assert res.tool_calls == ["teleport"] * 3
    assert res.tool_errors == 3
    assert "1С" in res.answer and "подключения/сервера" in res.answer


def test_circuit_breaker_resets_on_success() -> None:
    llm = FakeLLM(
        _fail_script(2)
        + [
            AssistantMessage(
                content=None,
                tool_calls=[ToolCall(id="c2", name="get_stock_balance", arguments='{"sku": "стул"}')],
            ),
            AssistantMessage(content="Готово."),
        ]
    )
    res = _run_with_breaker(llm, max_consecutive_errors=3)
    assert res.answer == "Готово."
    assert res.tool_errors == 2  # две ошибки подряд — терпимо, предохранитель не сработал


def test_circuit_breaker_disabled() -> None:
    llm = FakeLLM(_fail_script(5) + [AssistantMessage(content="Финал.")])
    res = _run_with_breaker(llm, max_consecutive_errors=0, max_rounds=10)
    assert res.answer == "Финал."
    assert res.tool_errors == 5


def _empty_search_reg() -> ToolRegistry:
    """Тулза, которая честно отвечает «найдено 0» — ошибкой это не считается."""
    from app.agent.tools import ToolDefinition
    from app.onec.schemas import StockArgs

    async def empty(args: StockArgs, ctx: object) -> str:
        return "Найдено 0 файлов по «вс11»"

    return ToolRegistry(
        [ToolDefinition(name="search_files", description="поиск файлов", args_model=StockArgs, handler=empty)]
    )


def _run_repeat(llm: FakeLLM, max_repeat_calls: int, max_rounds: int = 15) -> AgentResult:
    return asyncio.run(
        run_agent(
            llm=llm,
            registry=_empty_search_reg(),
            user_message="тест",
            max_rounds=max_rounds,
            max_repeat_calls=max_repeat_calls,
        )
    )


def _same_args_script(n: int, args: str) -> list[AssistantMessage]:
    return [
        AssistantMessage(content=None, tool_calls=[ToolCall(id=f"c{i}", name="search_files", arguments=args)])
        for i in range(n)
    ]


def test_repeat_breaker_gives_model_final_answer() -> None:
    """Живой случай: search_files × 23 одинаковыми аргументами съедал все раунды.

    Ответ «найдено 0» ошибкой не считается, поэтому предохранитель на ошибки
    молчит — нужен отдельный предохранитель на повторы. Сработав, он даёт модели
    ОДИН шанс ответить из того, что уже найдено, вместо тишины."""
    # 3 вызова (порог) + ответ на финальный запрос к LLM без инструментов.
    llm = FakeLLM(
        _same_args_script(3, '{"sku": "ВС11"}')
        + [AssistantMessage(content="Я нашёл объект ВС11, но формулу не посмотрел.")]
    )
    res = _run_repeat(llm, max_repeat_calls=3)
    assert res.tool_calls == ["search_files"] * 3
    assert res.tool_errors == 0  # это не ошибки
    assert res.answer == "Я нашёл объект ВС11, но формулу не посмотрел."


def test_repeat_breaker_final_call_has_no_tools() -> None:
    """Финальный ответ идёт с пустым списком схем — звать тулзы больше нельзя."""
    llm = FakeLLM(_same_args_script(3, '{"sku": "ВС11"}') + [AssistantMessage(content="Итог.")])
    _run_repeat(llm, max_repeat_calls=3)
    assert llm.seen_messages, "LLM не вызывался"
    last_seen, last_tools = llm.last_call
    assert last_tools == [], "в финальном вызове инструменты должны быть отключены"
    assert any("Ответь пользователю СЕЙЧАС" in str(m.get("content", "")) for m in last_seen), (
        "в финальный промпт должно попасть требование ответить сейчас"
    )


def test_repeat_breaker_fallback_when_model_silent() -> None:
    """Молчащая модель — отдаём заготовку, а не пустой ответ."""
    llm = FakeLLM(_same_args_script(3, '{"sku": "ВС11"}') + [AssistantMessage(content="   ")])
    res = _run_repeat(llm, max_repeat_calls=3)
    assert res.answer.strip()
    assert "записей не найдено" in res.answer or "зациклился" in res.answer


def test_repeat_breaker_fallback_when_llm_fails() -> None:
    """Упавший LLM на финальном вызове не роняет петлю — отдаём заготовку."""
    llm = FakeLLM(_same_args_script(10, '{"sku": "ВС11"}'))
    llm.raise_on_final = True
    res = _run_repeat(llm, max_repeat_calls=3)
    assert res.answer.strip()


def test_repeat_breaker_resets_when_result_has_content() -> None:
    """Разные аргументы И непустой результат — это прогресс, предохранитель молчит.

    Переформулировка запроса, которая наконец что-то нашла, обязана доезжать."""
    from app.agent.tools import ToolDefinition
    from app.onec.schemas import StockArgs

    async def found(args: StockArgs, ctx: object) -> str:
        return "Найдено 12 файлов по запросу"

    reg = ToolRegistry(
        [ToolDefinition(name="search_files", description="поиск файлов", args_model=StockArgs, handler=found)]
    )
    script = (
        _same_args_script(2, '{"sku": "ВС11"}')
        + _same_args_script(2, '{"sku": "СредняяЦена"}')
        + [AssistantMessage(content="Финал.")]
    )
    res = asyncio.run(
        run_agent(
            llm=FakeLLM(script),
            registry=reg,
            user_message="тест",
            max_rounds=10,
            max_repeat_calls=3,
        )
    )
    assert res.answer == "Финал."


def test_empty_breaker_stops_varied_args_empty_results() -> None:
    """Живой случай: search_files звали 14 раз, аргументы слегка менялись
    (head_limit 30/50/100, extension, glob), все ответы — «найдено 0»."""
    script = [
        AssistantMessage(
            content=None,
            tool_calls=[ToolCall(id=f"c{i}", name="search_files", arguments=args)],
        )
        for i, args in enumerate(
            [
                '{"sku": "ВС11", "head_limit": 30}',
                '{"sku": "ВС11", "head_limit": 50}',
                '{"sku": "ВС11", "head_limit": 100}',
            ]
        )
    ] + [AssistantMessage(content="Ответ по найденному.")]
    res = _run_repeat(FakeLLM(script), max_repeat_calls=3, max_rounds=10)
    assert len(res.tool_calls) == 3  # остановились на третьем пустом ответе
    # Дальше модель получила шанс ответить из того, что уже нашла.
    assert res.answer == "Ответ по найденному."


def test_empty_breaker_resets_on_different_tool() -> None:
    """Смена инструзма — не застревание: счётчик пустых ответов сбрасывается."""
    from app.agent.tools import ToolDefinition
    from app.onec.schemas import StockArgs

    async def empty(args: StockArgs, ctx: object) -> str:
        return "Найдено 0 файлов"

    async def found(args: StockArgs, ctx: object) -> str:
        return "Найдено 7 файлов"

    reg = ToolRegistry(
        [
            ToolDefinition(name="search_files", description="ф", args_model=StockArgs, handler=empty),
            ToolDefinition(name="search_code", description="к", args_model=StockArgs, handler=found),
        ]
    )
    script = _same_args_script(2, '{"sku": "ВС11"}') + [
        AssistantMessage(
            content=None,
            tool_calls=[ToolCall(id="cx", name="search_code", arguments='{"sku": "ВС11"}')],
        ),
        AssistantMessage(content="Финал."),
    ]
    res = asyncio.run(
        run_agent(
            llm=FakeLLM(script),
            registry=reg,
            user_message="тест",
            max_rounds=10,
            max_repeat_calls=3,
        )
    )
    assert res.answer == "Финал."


def _select_reg(rows_json: str) -> ToolRegistry:
    """Тулза execute_select, возвращающая заданный JSON (как 1С: {rows, truncated})."""
    from app.agent.tools import ToolDefinition
    from app.onec.schemas import ExecuteSelectArgs

    async def select(args: ExecuteSelectArgs, ctx: object) -> str:
        return rows_json

    return ToolRegistry(
        [ToolDefinition(name="execute_select", description="выборка 1С", args_model=ExecuteSelectArgs, handler=select)]
    )


def test_empty_breaker_counts_empty_rows_json() -> None:
    """Живой случай (МЭДОС): execute_select 3 раза подряд вернул {"rows": []} —
    петля обязана остановиться честным сообщением, а не перебором фильтров."""
    script = [
        AssistantMessage(
            content=None,
            tool_calls=[ToolCall(id=f"c{i}", name="execute_select", arguments='{"query": "ВЫБРАТЬ ..."}')],
        )
        for i in range(3)
    ] + [AssistantMessage(content="По этому фильтру записей нет.")]
    llm = FakeLLM(script)
    res = asyncio.run(
        run_agent(
            llm=llm,
            registry=_select_reg('{"rows": [], "truncated": false}'),
            user_message="тест",
            max_rounds=10,
            max_repeat_calls=3,
        )
    )
    assert len(res.tool_calls) == 3  # стоп на третьем пустом результате
    assert res.answer == "По этому фильтру записей нет."


def test_empty_breaker_ignores_nonempty_rows_json() -> None:
    """{"rows": [ ... ]} — это данные, не «пусто»: предохранитель молчит."""
    script = _same_args_script(2, '{"sku": "ВС11"}') + [
        AssistantMessage(
            content=None,
            tool_calls=[ToolCall(id="cx", name="execute_select", arguments='{"query": "ВЫБРАТЬ ..."}')],
        ),
        AssistantMessage(content="Финал."),
    ]

    async def found(args: object, ctx: object) -> str:
        return '{"rows": [{"Номер": "Хп0К-002747", "Сумма": 163473}], "truncated": false}'

    from app.agent.tools import ToolDefinition
    from app.onec.schemas import ExecuteSelectArgs

    reg = ToolRegistry(
        [ToolDefinition(name="execute_select", description="выборка 1С", args_model=ExecuteSelectArgs, handler=found)]
    )
    res = asyncio.run(
        run_agent(llm=FakeLLM(script), registry=reg, user_message="тест", max_rounds=10, max_repeat_calls=3)
    )
    assert res.answer == "Финал."


def test_no_tools_answer_with_history_gets_one_retry() -> None:
    """Живой случай (МЭДОС): в истории есть прошлый ответ с додуманными номерами,
    а на уточняющий вопрос модель отвечает tools=[]. Один повторный запрос обязан
    потребовать сначала выполнить инструмент; второй «без тулзов» — принимаем."""
    llm = FakeLLM(
        [
            AssistantMessage(content="Август: 8 накладных на 627 538,33 руб."),  # доверять нельзя
            AssistantMessage(
                content=None,
                tool_calls=[ToolCall(id="c1", name="get_stock_balance", arguments='{"sku": "стул"}')],
            ),
            AssistantMessage(content="По данным инструмента: остаток 42."),
        ]
    )
    res = asyncio.run(
        run_agent(
            llm=llm,
            registry=ToolRegistry(MOCK_ONEC_TOOLS),
            user_message="покажи суммарно за август",
            history=[{"role": "user", "content": "продажи по МЭДОС"}, {"role": "assistant", "content": "1 накладная"}],
            history_has_answer=True,
            max_rounds=6,
        )
    )
    assert res.answer == "По данным инструмента: остаток 42."
    # Повторный запрос ушёл к модели с требованием сначала выполнить инструмент.
    retry_msgs = llm.seen_messages[1]
    assert any("выполни запрос инструментом" in str(m.get("content", "")) for m in retry_msgs), (
        "повторный промпт должен требовать сначала выполнить инструмент"
    )


def test_no_tools_answer_without_history_not_retried() -> None:
    """Без истории с прошлым ответом финальный ответ без тулзов — обычный ответ."""
    llm = FakeLLM([AssistantMessage(content="Привет!")])
    res = _run(llm, "привет")
    assert res.answer == "Привет!"
    assert len(llm.seen_messages) == 1  # повторного запроса нет


def test_no_tools_retry_not_repeated() -> None:
    """Повтор «выполни инструмент» — ровно один раз: если модель всё равно
    отвечает без тулзов, принимаем ответ как есть (не зацикливаемся)."""
    llm = FakeLLM(
        [
            AssistantMessage(content="Первый ответ по памяти."),
            AssistantMessage(content="Второй ответ тоже по памяти."),
        ]
    )
    res = asyncio.run(
        run_agent(
            llm=llm,
            registry=ToolRegistry(MOCK_ONEC_TOOLS),
            user_message="итог",
            history=[{"role": "assistant", "content": "прошлый ответ"}],
            history_has_answer=True,
            max_rounds=6,
        )
    )
    assert res.answer == "Второй ответ тоже по памяти."
    assert len(llm.seen_messages) == 2  # ровно два обращения к LLM


def test_repeat_breaker_ignores_whitespace_differences() -> None:
    """Пробелы в JSON не должны обходить предохранитель."""
    script = [
        AssistantMessage(content=None, tool_calls=[ToolCall(id=f"c{i}", name="search_files", arguments=args)])
        for i, args in enumerate(['{"sku": "ВС11"}', '{"sku":  "ВС11"}', '{ "sku": "ВС11" }'])
    ] + [AssistantMessage(content="Хватит, отвечаю.")]
    llm = FakeLLM(script)
    res = _run_repeat(llm, max_repeat_calls=3, max_rounds=10)
    assert res.answer == "Хватит, отвечаю."


def test_repeat_breaker_disabled() -> None:
    llm = FakeLLM(_same_args_script(5, '{"sku": "ВС11"}') + [AssistantMessage(content="Финал.")])
    res = _run_repeat(llm, max_repeat_calls=0, max_rounds=10)
    assert res.answer == "Финал."
    assert len(res.tool_calls) == 5


def test_quoted_error_counts_as_error() -> None:
    # 1С иногда возвращает ошибку уже JSON-закодированной: '"Ошибка выполнения...'.
    from app.agent.tools import ToolDefinition
    from app.onec.schemas import StockArgs

    async def quoted_fail(args: StockArgs, ctx: object) -> str:
        return '"Ошибка выполнения инструмента: Server error 500"'

    reg = ToolRegistry(
        [ToolDefinition(name="boom", description="падающий тул", args_model=StockArgs, handler=quoted_fail)]
    )
    llm = FakeLLM(_fail_script(10, name="boom"))
    res = asyncio.run(run_agent(llm=llm, registry=reg, user_message="тест", max_rounds=15, max_consecutive_errors=2))
    assert res.tool_calls == ["boom"] * 2
    assert res.tool_errors == 2


def test_system_prompt_has_anti_hallucination_rule() -> None:
    # Антигаллюцинационное правило (живой случай: модель выдумала результаты
    # поиска, не вызвав ни одного search_code) — обязано быть в базовом промпте.
    from app.agent.loop import SYSTEM_PROMPT

    assert "выдумывать результаты инструментов" in SYSTEM_PROMPT


def _ambiguous_search_reg() -> ToolRegistry:
    """Тулза с живым форматом результата search_files: файлы из разных выгрузок."""
    from pydantic import BaseModel, Field

    from app.agent.tools import ToolDefinition

    class QueryArgs(BaseModel):
        query: str = Field(min_length=1)

    async def ambiguous(args: QueryArgs, ctx: object) -> str:
        return (
            "Найдено 8 файлов по «пс44»\n"
            "\n"
            "- `ТП601 КА ТД/ТП603 ПС/ПС44_ОтчетПоСвободнымОстаткамИРезервам/Ext/ObjectModule.bsl`\n"
            "- `ТП601 УПП/ТП603 ПС/ПС44_ОтчетПоСвободнымОстаткамИРезервамГП/Ext/ObjectModule.bsl`\n"
            "- `ТП601 УПП/ТП603 ПС/ПС44_ОтчетПоСвободнымОстаткамИРезервамГП/Forms/Форма/Ext/Form.module.bsl`\n"
        )

    return ToolRegistry(
        [ToolDefinition(name="search_files", description="поиск файлов", args_model=QueryArgs, handler=ambiguous)]
    )


def _run_ambiguous(llm: FakeLLM) -> AgentResult:
    return asyncio.run(
        run_agent(
            llm=llm,
            registry=_ambiguous_search_reg(),
            user_message="как считается колонка Резерв на 3.3 в отчете ПС44",
            max_rounds=6,
        )
    )


def test_ambiguous_search_injects_clarification_hint() -> None:
    """Живой случай (ПС44): поиск нашёл объект в КА ТД и УПП — модель не уточнила.

    После tool-результата с файлами из разных корневых папок к нему должна
    прикрепиться подсказка «задай уточняющий вопрос» (не отдельным system —
    llama.cpp требует system только в начале диалога)."""
    llm = FakeLLM(
        [
            AssistantMessage(
                content=None, tool_calls=[ToolCall(id="c1", name="search_files", arguments='{"query": "ПС44"}')]
            ),
            AssistantMessage(content="Нашёл два объекта ПС44 — уточните, какой?"),
        ]
    )
    _run_ambiguous(llm)
    second = llm.seen_messages[1]
    tool_msgs = [str(m.get("content", "")) for m in second if m.get("role") == "tool"]
    assert any("уточняющий вопрос" in c and "ТП601 КА ТД" in c and "ТП601 УПП" in c for c in tool_msgs), (
        "к tool-результату должна прикрепиться подсказка про неоднозначный поиск"
    )


def test_ambiguous_hint_injected_once_per_tool() -> None:
    """Подсказка — один раз на инструмент: повторный inject только шумит."""
    llm = FakeLLM(
        [
            AssistantMessage(
                content=None, tool_calls=[ToolCall(id="c1", name="search_files", arguments='{"query": "ПС44"}')]
            ),
            AssistantMessage(
                content=None,
                tool_calls=[ToolCall(id="c2", name="search_files", arguments='{"query": "ПС44 остаткам"}')],
            ),
            AssistantMessage(content="Уточните объект."),
        ]
    )
    _run_ambiguous(llm)
    second = llm.seen_messages[1]
    third = llm.seen_messages[2]

    def hint_count(msgs: list[dict[str, object]]) -> int:
        return sum(1 for m in msgs if m.get("role") == "tool" and "уточняющий вопрос" in str(m.get("content", "")))

    # Подсказка остаётся в контексте (это нормально — модель видит её дальше),
    # но повторного inject нет: число tool-сообщений с подсказкой не растёт.
    assert hint_count(second) == 1, "после первого неоднозначного поиска — ровно одна подсказка"
    assert hint_count(third) == 1, "повторный inject одного и того же инструмента не нужен"


def test_single_root_search_has_no_hint() -> None:
    """Файлы из одной выгрузки — неоднозначности нет, подсказка не нужна."""
    from pydantic import BaseModel, Field

    from app.agent.tools import ToolDefinition

    class QueryArgs(BaseModel):
        query: str = Field(min_length=1)

    async def single(args: QueryArgs, ctx: object) -> str:
        return (
            "Найдено 3 файла по «фс192»\n"
            "\n"
            "- `ТП601 УПП/ТП603 ПС/ФС192_Расходы/Ext/ObjectModule.bsl`\n"
            "- `ТП601 УПП/ТП603 ПС/ФС192_Расходы/Forms/Форма/Ext/Form.module.bsl`\n"
        )

    reg = ToolRegistry(
        [ToolDefinition(name="search_files", description="поиск файлов", args_model=QueryArgs, handler=single)]
    )
    llm = FakeLLM(
        [
            AssistantMessage(
                content=None, tool_calls=[ToolCall(id="c1", name="search_files", arguments='{"query": "ФС192"}')]
            ),
            AssistantMessage(content="Нашёл один объект."),
        ]
    )
    asyncio.run(run_agent(llm=llm, registry=reg, user_message="тест", max_rounds=6))
    second = llm.seen_messages[1]
    hints = [m for m in second if m.get("role") == "tool" and "уточняющий вопрос" in str(m.get("content", ""))]
    assert hints == [], "при одной выгрузке подсказка не нужна"
