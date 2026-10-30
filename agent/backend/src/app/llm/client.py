"""Клиент LLM через OpenAI-совместимый HTTP API.

Петля агента зависит только от протокола ChatLLM — в тестах подменяется фейком,
провайдер (llama.cpp-server, Ollama, облако) задаётся base_url в конфиге.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

from openai import AsyncOpenAI, BadRequestError


class ContextOverflowError(RuntimeError):
    """Запрос не влез в окно модели.

    llama.cpp/Ollama отвечают 400 с `exceed_context_size_error` и числом
    `n_ctx`; облачные провайдеры — текстом про context length. Петля ловит
    эту ошибку, сворачивает контекст и повторяет запрос вместо того, чтобы
    отдать пользователю «чат упал».
    """

    def __init__(self, detail: str, context_limit: int | None = None) -> None:
        super().__init__(detail)
        #: Окно модели в токенах, если провайдер его сообщил (llama.cpp — n_ctx).
        self.context_limit = context_limit


class RequestCancelledError(RuntimeError):
    """Пользователь отменил запрос (кнопка «Отменить» в окне ожидания 1С).

    Бросается петлёй агента по флагу отмены: дальше не думает и не зовёт
    инструменты, отвечает короткой заглушкой. Отдельный класс (не
    asyncio.CancelledError) — чтобы не путать с убийством task и ловить
    в точках, где CancelledError обязан пробрасываться.
    """


#: Признаки переполнения в теле 400-го ответа провайдера.
_OVERFLOW_MARKERS = (
    "exceed_context_size_error",
    "exceeds the available context size",
    "context_length_exceeded",
    "maximum context length",
)

_N_CTX_RE = re.compile(r'"n_ctx"\s*:\s*(\d+)')
_N_PROMPT_RE = re.compile(r'"n_prompt_tokens"\s*:\s*(\d+)')


def _overflow_detail(exc: Exception) -> str:
    """Короткое описание переполнения для лога: окно и размер запроса, если есть.

    llama.cpp кладёт в тело 400-го `n_ctx` и `n_prompt_tokens`; у облачных
    провайдеров их нет — тогда остаётся текст ошибки.
    """
    text = str(exc)
    n_ctx = _N_CTX_RE.search(text)
    n_prompt = _N_PROMPT_RE.search(text)
    if n_ctx or n_prompt:
        return (
            "переполнение окна модели: "
            f"запрос {n_prompt.group(1) if n_prompt else '?'} токенов, "
            f"окно {n_ctx.group(1) if n_ctx else '?'}"
        )
    return f"переполнение окна модели: {text[:300]}"


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str  # сырой JSON от модели


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass
class AssistantMessage:
    content: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)
    # Токены шага из usage ответа OpenAI-совместимого API. None — провайдер
    # не вернул usage (или фейк в тестах); петля тогда считает нули.
    usage: Usage | None = None


class ChatLLM(Protocol):
    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        cancel_event: asyncio.Event | None = None,
    ) -> AssistantMessage:
        """Один шаг: сообщения + схемы инструментов -> ответ модели.

        cancel_event — опциональное событие отмены: если поставлено во время
        запроса, клиент должен бросить RequestCancelledError (или прервать
        HTTP-запрос). Фейки в тестах могут игнорировать параметр.
        """
        ...


def build_user_content(
    text: str,
    attachments: list[dict[str, str]] | None = None,
) -> str | list[dict[str, Any]]:
    """Сформировать multimodal content для OpenAI-совместимого API.

    - без вложений: str
    - с вложениями: list content parts:
        * {type: text, text: ...} для исходного сообщения
        * {type: image_url, image_url: {url: data:...}} для image/*
        * {type: text, text: "[Вложение: name (mime)]"} для остальных
    Base64 передаём как data URI для image, для документов — текстовый маркер.
    """
    if not attachments:
        return text
    parts: list[dict[str, Any]] = [{"type": "text", "text": text}] if text else []
    for att in attachments:
        filename = att.get("filename") or att.get("name") or "file"
        mime = att.get("mime_type") or att.get("mime") or "application/octet-stream"
        b64 = att.get("content_base64") or att.get("data_base64") or ""
        if mime.startswith("image/") and b64:
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"},
                }
            )
            # Дублируем имя для контекста
            parts.append({"type": "text", "text": f"[Изображение: {filename} ({mime})]"})
        else:
            # Не-image: передаём как текстовый маркер, не льём сырой base64 в промпт
            snippet = b64[:120] + "..." if len(b64) > 120 else b64
            if b64:
                parts.append(
                    {
                        "type": "text",
                        "text": f"[Вложение: {filename} ({mime}) base64:{snippet[:80]}...]",
                    }
                )
            else:
                parts.append({"type": "text", "text": f"[Вложение: {filename} ({mime})]"})
    return parts if parts else text


class OpenAICompatibleLLM:
    """AsyncOpenAI-клиент с сэмплингом из карточки qwen3.8-27b-1C."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        temperature: float = 0.6,
        top_p: float = 0.95,
        top_k: int = 20,
        repetition_penalty: float = 1.3,
        enable_thinking: bool = False,
    ) -> None:
        # Пустой ключ из .env ронял AsyncOpenAI до запроса — подменяем на dummy
        norm_key = (api_key or "").strip()
        if not norm_key or norm_key == "change-me":
            norm_key = "none"
        norm_url = (base_url or "").strip() or "http://localhost:8080/v1"
        if norm_url == "https://api.example.com/v1":
            norm_url = "http://localhost:8080/v1"
        self._client = AsyncOpenAI(base_url=norm_url, api_key=norm_key)
        self._model = model
        self._temperature = temperature
        self._top_p = top_p
        self._extra_body: dict[str, Any] = {
            "top_k": top_k,
            "repetition_penalty": repetition_penalty,
        }
        if not enable_thinking:
            # Формат llama.cpp/Ollama для Qwen3: гасим thinking-режим.
            # Остальные провайдеры неизвестное поле игнорируют.
            self._extra_body["chat_template_kwargs"] = {"enable_thinking": False}

    async def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        cancel_event: asyncio.Event | None = None,
    ) -> AssistantMessage:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "temperature": self._temperature,
            "top_p": self._top_p,
            "extra_body": self._extra_body,
        }
        if tools:
            kwargs["tools"] = tools
        try:
            # Отмена во время запроса к LLM: ждём либо ответ модели, либо флаг.
            # asyncio.wait (FIRST_COMPLETED) — не убиваем task, просто перестаём ждать.
            llm_task = asyncio.ensure_future(self._client.chat.completions.create(**kwargs))
            if cancel_event is not None:
                cancel_waiter = asyncio.ensure_future(cancel_event.wait())
                done, _pending = await asyncio.wait({llm_task, cancel_waiter}, return_when=asyncio.FIRST_COMPLETED)
                if cancel_waiter in done and not llm_task.done():
                    # Отмена пришла раньше ответа: отменяем запрос к LLM.
                    llm_task.cancel()
                    try:
                        await llm_task
                    except (asyncio.CancelledError, Exception):  # noqa: BLE001 — ответ уже не нужен
                        pass
                    raise RequestCancelledError("запрос отменён во время обращения к модели")
                if cancel_waiter not in done:
                    cancel_waiter.cancel()
            resp = await llm_task
        except BadRequestError as exc:
            # Переполнение окна — не повод ронять чат: петля свернёт контекст
            # и повторит запрос (см. ContextOverflowError).
            text = str(exc)
            if any(marker in text.lower() for marker in _OVERFLOW_MARKERS):
                n_ctx = _N_CTX_RE.search(text)
                raise ContextOverflowError(
                    _overflow_detail(exc),
                    context_limit=int(n_ctx.group(1)) if n_ctx else None,
                ) from exc
            raise
        msg = resp.choices[0].message
        calls = [
            ToolCall(id=c.id, name=c.function.name, arguments=c.function.arguments or "{}")
            for c in (msg.tool_calls or [])
        ]
        usage = None
        if resp.usage is not None:
            usage = Usage(
                prompt_tokens=resp.usage.prompt_tokens or 0,
                completion_tokens=resp.usage.completion_tokens or 0,
            )
        return AssistantMessage(content=msg.content, tool_calls=calls, usage=usage)
