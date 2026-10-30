"""Тесты отмены запроса: кнопка «Отменить» в окне ожидания 1С.

Проверяем:
- POST /chat/cancel/{session_id} ставит флаг (200) или 404 для чужой сессии;
- петля агента видит флаг и бросает RequestCancelledError;
- эндпоинт /chat отвечает заглушкой «Запрос отменён» и НЕ пишет ответ в сессию.

Проверка истории — через GET /sessions/{id}/messages (публичный API), чтобы не
мешать event loop TestClient прямыми запросами к БД из синхронного теста.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.agent import ToolRegistry, run_agent
from app.llm import AssistantMessage, RequestCancelledError
from app.main import app


def _parse_sse(body: str) -> dict[str, list[dict[str, Any]]]:
    """Разбор SSE-тела в события (как в test_chat_api)."""
    events: dict[str, list[dict[str, Any]]] = {}
    current_event = "message"
    data_lines: list[str] = []
    for line in body.splitlines():
        if line.startswith("event:"):
            current_event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
        elif line == "" and data_lines:
            raw = "\n".join(data_lines)
            try:
                events.setdefault(current_event, []).append(json.loads(raw))
            except ValueError:
                pass
            data_lines = []
    return events


def test_cancel_endpoint_404_for_unknown_session() -> None:
    """Отмена несуществующей сессии — 404."""
    client = TestClient(app)
    with client:
        r = client.post("/chat/cancel/99999")
        assert r.status_code == 404, r.text


def test_cancel_endpoint_200_for_existing_session() -> None:
    """Отмена существующей сессии — 200 ok."""
    client = TestClient(app)
    with client:
        # Создаём сессию через /chat.
        r = client.post("/chat", json={"message": "привет", "user_id": "cancel-test-user"})
        assert r.status_code == 200, r.text
        events = _parse_sse(r.text)
        session_id = None
        for ev in events.get("done", []):
            if "session_id" in ev:
                session_id = ev["session_id"]
                break
        assert session_id is not None, f"нет session_id в done: {r.text[:300]}"
        # Теперь отменяем.
        r2 = client.post(f"/chat/cancel/{session_id}")
        assert r2.status_code == 200, r2.text
        assert r2.json()["ok"] is True


def test_run_agent_stops_on_cancel() -> None:
    """Петля бросает RequestCancelledError, если флаг поставлен до старта."""
    registry = ToolRegistry([])
    llm = _FakeLLM([AssistantMessage(content="ответ")])
    ev = asyncio.Event()
    ev.set()  # отмена уже стоит

    with pytest.raises(RequestCancelledError):
        asyncio.new_event_loop().run_until_complete(
            run_agent(llm=llm, registry=registry, user_message="привет", cancel_event=ev)
        )


def test_chat_returns_cancelled_stub_and_no_history() -> None:
    """/chat с отменой: ответ «Запрос отменён», в сессию ответ НЕ пишется.

    Отмена ставится ДО запроса (флаг живёт до TTL 60 c), поэтому чат видит
    её на первом же раунде и отвечает заглушкой. Это проверяет всю цепочку:
    /chat/cancel -> get_cancel_event -> run_agent -> RequestCancelledError ->
    заглушка в SSE + отсутствие assistant-сообщения в истории (GET /sessions).
    """
    from app.api.chat import get_llm, get_registry

    llm = _SlowLLM()
    app.dependency_overrides[get_llm] = lambda: llm
    app.dependency_overrides[get_registry] = lambda: ToolRegistry([])

    client = TestClient(app)
    try:
        with client:
            # 1. Создаём сессию (быстрый ответ, отмена ещё не стоит).
            r0 = client.post("/chat", json={"message": "привет", "user_id": "cancel-test-user3"})
            assert r0.status_code == 200, r0.text
            events0 = _parse_sse(r0.text)
            session_id = None
            for ev in events0.get("done", []):
                if "session_id" in ev:
                    session_id = ev["session_id"]
                    break
            assert session_id is not None

            # 2. Ставим отмену на эту сессию (флаг живёт до TTL).
            r_c = client.post(f"/chat/cancel/{session_id}")
            assert r_c.status_code == 200, r_c.text

            # 3. Второй запрос в ту же сессию: петля видит флаг на первом раунде.
            r1 = client.post(
                "/chat", json={"message": "ещё вопрос", "user_id": "cancel-test-user3", "session_id": session_id}
            )
            assert r1.status_code == 200, r1.text
            events1 = _parse_sse(r1.text)
            answer = "".join(e.get("delta", "") for e in events1.get("answer", []))
            assert "отмен" in answer.lower(), f"ожидали заглушку отмены, получили: {answer!r}"

            # 4. История через публичный API: ровно 2 user + 1 assistant (от первого).
            r_h = client.get(f"/sessions/{session_id}/messages")
            assert r_h.status_code == 200, r_h.text
            msgs = r_h.json()
            # Формат: список {role, content} или объект {messages: [...]}.
            if isinstance(msgs, dict):
                msgs = msgs.get("messages", [])
            roles = [m.get("role") for m in msgs]
            user_count = roles.count("user")
            assistant_count = roles.count("assistant")
            assert user_count == 2, f"ожидали 2 user-сообщения, получили {user_count}: {roles}"
            assert assistant_count == 1, (
                f"ожидали 1 assistant-сообщение (от первого запроса), получили {assistant_count} "
                "(ответ отменённого запроса не должен писаться в сессию)"
            )
    finally:
        app.dependency_overrides.pop(get_llm, None)
        app.dependency_overrides.pop(get_registry, None)


class _FakeLLM:
    """Фейк для run_agent: один ответ, без инструментов."""

    def __init__(self, script: list[AssistantMessage]) -> None:
        self._script = list(script)

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        cancel_event: asyncio.Event | None = None,  # noqa: ARG002 — фейк не отменяется
    ) -> AssistantMessage:
        return self._script.pop(0)


class _SlowLLM:
    """Модель думает 0.5 с — время для отмены во время запроса."""

    def __init__(self) -> None:
        self.cancelled = False

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        cancel_event: asyncio.Event | None = None,
    ) -> AssistantMessage:
        if cancel_event is not None:
            # Ждём либо таймаут 0.5 с, либо отмену.
            try:
                await asyncio.wait_for(asyncio.shield(cancel_event.wait()), timeout=0.5)
                self.cancelled = True
                raise RequestCancelledError("запрос отменён во время обращения к модели")
            except TimeoutError:
                pass
        return AssistantMessage(content="ответ после 0.5 с")
