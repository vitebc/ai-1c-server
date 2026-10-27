"""Бюджет контекста: обрезка результатов, сворачивание истории, повтор после переполнения.

Живой случай (прод, 2026-10-27): вопрос «покажи продажи Ассоль за 2025 год» —
128 схем инструментов + 28 результатов на 91 572 символа дали запрос на
64 342 токена при окне 64 256. LLM ответила 400 `exceed_context_size_error`,
чат упал. Здесь проверяем, что контекст не растёт бесконтрольно и что
переполнение превращается в ответ, а не в ошибку.
"""

from __future__ import annotations

import asyncio

from pydantic import BaseModel

from app.agent import AgentResult, ToolRegistry, run_agent
from app.agent.context import (
    MAX_TOOL_RESULT_CHARS,
    SHRUNK_PREFIX,
    compact_history,
    shrink_messages,
    truncate_tool_result,
)
from app.agent.loop import TOO_LONG_ANSWER
from app.agent.tools import ToolContext, ToolDefinition
from app.llm import AssistantMessage, ToolCall
from app.tools import MOCK_ONEC_TOOLS
from tests.fake_llm import FakeLLM


class _EmptyArgs(BaseModel):
    pass


async def _huge_result(args: _EmptyArgs, ctx: ToolContext) -> str:
    return "x" * 20_000


HUGE_TOOL = ToolDefinition(
    name="huge_tool",
    description="возвращает огромный результат",
    args_model=_EmptyArgs,
    handler=_huge_result,
)


def _run(llm: FakeLLM, registry: ToolRegistry | None = None, max_rounds: int = 3) -> AgentResult:
    return asyncio.run(
        run_agent(
            llm=llm,
            registry=registry or ToolRegistry(MOCK_ONEC_TOOLS),
            user_message="тест",
            max_rounds=max_rounds,
        )
    )


# --- обрезка одного результата -------------------------------------------------


def test_truncate_tool_result_keeps_short_text() -> None:
    assert truncate_tool_result("короткий ответ") == "короткий ответ"


def test_truncate_tool_result_cuts_long_text_and_marks_it() -> None:
    text = "y" * 20_000
    out = truncate_tool_result(text)
    assert out.startswith("y" * 100)
    assert "результат обрезан" in out
    assert "Данные неполные" in out
    # Тело — не длиннее лимита плюс короткая пометка (не удваиваем 20k).
    assert len(out) < MAX_TOOL_RESULT_CHARS + 500


def test_tool_result_in_context_is_truncated_trace_keeps_full() -> None:
    llm = FakeLLM(
        [
            AssistantMessage(
                content=None,
                tool_calls=[ToolCall(id="c1", name="huge_tool", arguments="{}")],
            ),
            AssistantMessage(content="Готово."),
        ]
    )
    res = _run(llm, registry=ToolRegistry([HUGE_TOOL]))
    tool_msgs = [m for m in llm.seen_messages[1] if m.get("role") == "tool"]
    assert len(tool_msgs) == 1
    assert len(str(tool_msgs[0]["content"])) < MAX_TOOL_RESULT_CHARS + 500
    assert "результат обрезан" in str(tool_msgs[0]["content"])
    # В трасс админки уходит полный результат — обрезка касается только промпта.
    assert any(step.role == "tool" and len(step.content) == 20_000 for step in res.round_steps)


# --- сворачивание старых результатов -------------------------------------------


def test_shrink_messages_shrinks_oldest_and_keeps_last_two() -> None:
    messages = [
        {"role": "system", "content": "системный промпт"},
        {"role": "user", "content": "вопрос"},
        {"role": "tool", "tool_call_id": "a", "content": "a" * 30_000},
        {"role": "tool", "tool_call_id": "b", "content": "b" * 30_000},
        {"role": "tool", "tool_call_id": "c", "content": "c" * 30_000},
    ]
    shrunk = shrink_messages(messages, budget_tokens=1000)
    assert shrunk == 1
    assert str(messages[2]["content"]).startswith(SHRUNK_PREFIX)
    assert messages[3]["content"] == "b" * 30_000
    assert messages[4]["content"] == "c" * 30_000


def test_shrink_messages_aggressive_mode_shrinks_last_too() -> None:
    messages = [
        {"role": "user", "content": "вопрос"},
        {"role": "tool", "tool_call_id": "a", "content": "a" * 30_000},
    ]
    shrunk = shrink_messages(messages, budget_tokens=1000, keep_full=0, stub_chars=100)
    assert shrunk == 1
    assert str(messages[1]["content"]).startswith(SHRUNK_PREFIX)


def test_shrink_messages_does_nothing_when_fits() -> None:
    messages = [{"role": "tool", "tool_call_id": "a", "content": "мало"}]
    assert shrink_messages(messages, budget_tokens=60_000) == 0
    assert messages[0]["content"] == "мало"


# --- сжатие истории диалога ----------------------------------------------------


def test_compact_history_drops_old_messages_and_keeps_fresh() -> None:
    kept = compact_history(
        ["старое " * 1000, "среднее " * 700, "свежее " * 500],
        message_chars=1000,
        total_chars=2500,
    )
    assert len(kept) == 2
    assert kept[-1].startswith("свежее")
    assert "старое" not in kept[0]


def test_compact_history_truncates_long_message() -> None:
    kept = compact_history(["q" * 10_000], message_chars=1000, total_chars=20_000)
    assert len(kept) == 1
    assert "сообщение обрезано" in kept[0]
    assert len(kept[0]) < 1100


# --- переполнение окна ---------------------------------------------------------


def test_overflow_retries_once_after_shrinking() -> None:
    llm = FakeLLM([AssistantMessage(content="Готово после повтора.")])
    llm.overflow_times = 1
    res = _run(llm)
    assert res.answer == "Готово после повтора."
    # Первый вызов упал, второй (после сворачивания) прошёл — два обращения.
    assert len(llm.seen_messages) == 2


def test_double_overflow_returns_readable_answer_instead_of_error() -> None:
    llm = FakeLLM([AssistantMessage(content="не дойдёт")])
    llm.overflow_times = 2
    res = _run(llm)
    assert res.answer == TOO_LONG_ANSWER
    assert "слишком длинным" in res.answer
