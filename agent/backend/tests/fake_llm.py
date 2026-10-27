"""Фейковый LLM для тестов: отдаёт заготовленные ответы, пишет входящие."""

from __future__ import annotations

from typing import Any

from app.llm import AssistantMessage, ContextOverflowError


class FakeLLM:
    def __init__(self, script: list[AssistantMessage]) -> None:
        self._script = list(script)
        self.seen_messages: list[list[dict[str, Any]]] = []
        #: Последний вызов: (сообщения, схемы инструментов). Пустые схемы = финальный
        #: вызов после срабатывания предохранителя (инструменты отключены).
        self.last_call: tuple[list[dict[str, Any]], list[dict[str, Any]]] = ([], [])
        #: Бросить исключение на финальном вызове (LLM упал) — для теста заготовки.
        self.raise_on_final = False
        #: Сколько раз бросить ContextOverflowError до нормального ответа.
        #: >0 — проверка реактивного сворачивания; больше одного — внятный отказ.
        self.overflow_times = 0

    async def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> AssistantMessage:
        # Копия: петля дописывает в тот же список по ходу раундов.
        self.seen_messages.append(list(messages))
        self.last_call = (list(messages), list(tools))
        if self.raise_on_final and not tools:
            raise RuntimeError("LLM недоступен")
        if self.overflow_times > 0:
            self.overflow_times -= 1
            raise ContextOverflowError("переполнение окна модели: запрос 64342 токенов, окно 64256", 64256)
        return self._script.pop(0)
