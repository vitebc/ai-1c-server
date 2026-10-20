"""Тесты эмбеддингов: llamacpp/TEI-клиенты на mock-транспорте, fake — детерминированность."""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Coroutine
from typing import Any

import httpx

from app.rag import FakeEmbeddings, LlamaCppEmbeddings, TEIEmbeddings


def _run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def test_tei_batch() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json=[[0.1, 0.2], [0.3, 0.4]])

    client = TEIEmbeddings("http://tei:80", transport=httpx.MockTransport(handler))
    vecs = _run(client.embed(["a", "b"]))
    assert seen["path"] == "/embed"
    assert seen["body"] == {"inputs": ["a", "b"]}
    assert vecs == [[0.1, 0.2], [0.3, 0.4]]


def test_tei_single_vector_unwrapped() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[0.5, 0.6])

    client = TEIEmbeddings("http://tei:80", transport=httpx.MockTransport(handler))
    assert _run(client.embed(["a"])) == [[0.5, 0.6]]
    assert _run(client.embed([])) == []


def test_llamacpp_batch_sorted_by_index() -> None:
    """Батч может вернуться не в исходном порядке — сортируем по index."""
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content.decode())
        # Ответ с обратным порядком index: клиент обязан восстановить исходный.
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": [0.3, 0.4]},
                    {"index": 0, "embedding": [0.1, 0.2]},
                ]
            },
        )

    client = LlamaCppEmbeddings("http://llama:12700/v1", transport=httpx.MockTransport(handler))
    vecs = _run(client.embed(["a", "b"]))
    assert seen["path"] == "/v1/embeddings"
    assert seen["body"] == {"input": ["a", "b"]}
    assert vecs == [[0.1, 0.2], [0.3, 0.4]]


def test_llamacpp_model_sent_when_set() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.5]}]})

    client = LlamaCppEmbeddings("http://llama:12700/v1", model="qwen3", transport=httpx.MockTransport(handler))
    assert _run(client.embed(["a"])) == [[0.5]]
    assert seen["body"] == {"input": ["a"], "model": "qwen3"}


def test_llamacpp_query_has_instruct_prefix() -> None:
    """Запрос retrieval эмбеддится асимметрично — с instruct-префиксом."""
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.5, 0.6]}]})

    client = LlamaCppEmbeddings("http://llama:12700/v1", transport=httpx.MockTransport(handler))
    assert _run(client.embed_query("цифровой рубль", "Instruct: найди\nQuery: ")) == [0.5, 0.6]
    assert seen["body"]["input"] == ["Instruct: найди\nQuery: цифровой рубль"]


def test_llamacpp_query_without_instruction_is_plain() -> None:
    """Без инструкции запрос эмбеддится как обычный текст."""
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.5]}]})

    client = LlamaCppEmbeddings("http://llama:12700/v1", transport=httpx.MockTransport(handler))
    assert _run(client.embed_query("цифровой рубль")) == [0.5]
    assert seen["body"]["input"] == ["цифровой рубль"]


def test_llamacpp_empty_input() -> None:
    client = LlamaCppEmbeddings("http://llama:12700/v1", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    assert _run(client.embed([])) == []


def test_fake_deterministic_and_normalized() -> None:
    fake = FakeEmbeddings(dim=32)
    v1, v2, v3 = _run(fake.embed(["стул", "стул", "стол"]))
    assert v1 == v2
    assert v1 != v3
    assert math.isclose(sum(x * x for x in v1), 1.0, rel_tol=1e-6)
    assert len(v1) == 32


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def test_fake_lexical_similarity() -> None:
    fake = FakeEmbeddings(dim=256)
    base, close, far = _run(fake.embed(["стул офисный на складе", "стул офисный", "дебиторская задолженность суда"]))
    assert _cos(base, close) > _cos(base, far) + 0.2
