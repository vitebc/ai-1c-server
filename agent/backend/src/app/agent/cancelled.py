"""Флаги отмены запросов: кнопка «Отменить» в окне ожидания 1С.

Механика: POST /chat/cancel/{session_id} ставит событие; петля агента
(run_agent) получает его через get_cancel_event и проверяет между раундами
и перед каждым вызовом инструмента. Событие живёт до TTL (60 c) после
последнего доступа — отмена уже завершившегося запроса просто истекает.

Ключ: session_id (int). Сессия в БД принадлежит одному пользователю,
поэтому чужую сессию отменить нельзя — событие не найдётся (404).
user_id в ключе не нужен: он известен только из тела /chat, а эндпоинт
отмены ходит без тела.
"""

from __future__ import annotations

import asyncio
import time

#: Время жизни события после последнего доступа (сек). Запрос дольше живёт —
#: событие продлевается при каждом обращении петли.
_TTL_SECONDS = 60.0


class _CancelledRegistry:
    """In-memory реестр событий отмены (один процесс, GIL)."""

    def __init__(self) -> None:
        self._events: dict[int, tuple[asyncio.Event, float]] = {}

    def get(self, session_id: int | None) -> asyncio.Event:
        """Событие отмены для запроса; создаётся при первом обращении."""
        if session_id is None:
            # Без сессии отмена невозможна — пустое событие, никогда не set.
            return _NEVER
        now = time.monotonic()
        ev, _last_seen = self._events.get(session_id, (asyncio.Event(), now))
        self._events[session_id] = (ev, now)  # продлеваем TTL
        return ev

    def cancel(self, session_id: int | None) -> bool:
        """Поставить флаг отмены. True — сессия задана, False — нет."""
        if session_id is None:
            return False
        now = time.monotonic()
        ev, _last_seen = self._events.get(session_id, (asyncio.Event(), now))
        ev.set()
        self._events[session_id] = (ev, now)
        return True

    def clear(self, session_id: int | None) -> None:
        """Убрать событие (после завершения запроса)."""
        if session_id is not None:
            self._events.pop(session_id, None)

    def cleanup(self) -> None:
        """Удалить истёкшие события."""
        now = time.monotonic()
        expired = [k for k, (_, last) in self._events.items() if now - last > _TTL_SECONDS]
        for k in expired:
            del self._events[k]


#: Событие-заглушка для запросов без сессии: никогда не set.
_NEVER = asyncio.Event()

_registry = _CancelledRegistry()


def get_cancel_event(session_id: int | None) -> asyncio.Event:
    """Событие отмены для текущего запроса (см. модуль)."""
    return _registry.get(session_id)


def cancel_session(session_id: int | None) -> bool:
    """Поставить флаг отмены (эндпоинт /chat/cancel). True — сессия задана."""
    return _registry.cancel(session_id)


def clear_cancel_event(session_id: int | None) -> None:
    """Снять флаг после завершения запроса."""
    _registry.clear(session_id)


__all__ = ["get_cancel_event", "cancel_session", "clear_cancel_event"]
