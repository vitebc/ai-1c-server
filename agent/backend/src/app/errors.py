"""Понятные пользователю тексты ошибок чата.

В ответ пользователю (форма 1С) уходит короткая фраза без технических
деталей — URL модели, тип исключения, подсказки про `.env`: сотрудник не
должен читать трейс. Подробности живут в логе (с кодом ошибки) и в
`chat_requests.error`, откуда их видит администратор в админке.

Правило: текст в чате отвечает на «что случилось и что делать», а не
«какой стектрейс».
"""

from __future__ import annotations

import uuid

import httpx

# Нет связи с моделью: сервис выключен, порт закрыт, сеть недоступна, таймаут.
LLM_UNAVAILABLE = (
    "Модель ИИ сейчас недоступна — нет связи с сервером модели. "
    "Попробуйте ещё раз через пару минут; если не помогает, сообщите администратору."
)
# Связь есть, но модель/шлюз вернул ошибку (4xx/5xx, невалидный ответ).
LLM_ERROR = (
    "Модель ИИ не смогла ответить — произошла ошибка на стороне модели. "
    "Попробуйте повторить запрос или переформулировать вопрос."
)
# Сбой слоя эмбеддингов (подбор скила / поиск по базе знаний).
EMBEDDINGS_UNAVAILABLE = "Подбор сценария сейчас недоступен — отвечаю без него."
KB_UNAVAILABLE = "Поиск по базе знаний сейчас недоступен — отвечаю без него."
# Непредвиденное: код нужен, чтобы связать сообщение в чате с трейсом в логе.
INTERNAL_TEMPLATE = (
    "Не удалось обработать запрос: внутренняя ошибка сервера (код {code}). "
    "Сообщите администратору этот код — по нему найдём причину в журнале."
)

# Сетевые сбои httpx (и встроенные), при которых «модель недоступна».
_NETWORK_ERRORS: tuple[type[BaseException], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.PoolTimeout,
    httpx.RemoteProtocolError,
    ConnectionError,
    TimeoutError,
)


def error_code() -> str:
    """Короткий код для связи текста в чате с трейсом в логе."""
    return uuid.uuid4().hex[:8]


def internal(code: str) -> str:
    return INTERNAL_TEMPLATE.format(code=code)


def is_network(exc: BaseException) -> bool:
    return isinstance(exc, _NETWORK_ERRORS)


def llm(exc: BaseException) -> str:
    """Текст для сбоя обращения к модели: нет связи vs ошибка на её стороне."""
    return LLM_UNAVAILABLE if is_network(exc) else LLM_ERROR
