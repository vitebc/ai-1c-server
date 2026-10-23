"""Эмбеддинги: провайдер выбирается конфигом.

- llamacpp: OpenAI-совместимый /v1/embeddings (llama.cpp-server с
  Qwen3-Embedding-4B). Кириллица, 2560 измерений.
- tei: настоящий TEI-сервис (native /embed API), профиль rag в compose.
- fake: детерминированные вектора для dev/test без GPU и без скачивания
  моделей. Ранжирование идёт по лексическому пересечению (сумма word-seeded
  векторов) — честный plumbing-тест retrieval, не качество поиска.

Запрос и документ эмбеддятся по-разному: retrieval asymmetric — к запросу
добавляется instruct-префикс (модель обучена на этом формате), документ
идёт как есть. Префикс задаёт ЗАДАЧУ, поэтому он приходит аргументом:
у retrieval и у матчинга скилов он разный.
"""

from __future__ import annotations

import hashlib
import math
import random
import re
from typing import Any, Protocol

import httpx

from app.db.models import EMBEDDING_DIM

_WORD = re.compile(r"\w+", re.UNICODE)


class Embeddings(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]:
        """По вектору на каждый текст, порядок сохраняется.

        Сторона документов: без инструкции.
        """
        ...

    async def embed_query(self, text: str, instruction: str = "") -> list[float]:
        """Вектор запроса (с instruct-префиксом, если он задан).

        instruction — описание задачи поиска. Пустая строка = без префикса
        (симметричное сравнение).
        """
        ...


class LlamaCppEmbeddings:
    """Клиент OpenAI-совместимого /v1/embeddings (llama.cpp-server).

    Ответ: {"data": [{"index": i, "embedding": [...]}, ...]}. Вектора
    приходят L2-нормированными (проверено на Qwen3-Embedding-4B).
    """

    def __init__(
        self,
        base_url: str,
        model: str = "",
        timeout: float = 120.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._timeout = timeout
        self._transport = transport

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        payload: dict[str, Any] = {"input": texts}
        if self._model:
            payload["model"] = self._model
        async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
            resp = await client.post(f"{self._base_url}/embeddings", json=payload)
            resp.raise_for_status()
            data: Any = resp.json()
        # Сортируем по index: батч может вернуться не в исходном порядке.
        items = sorted(data["data"], key=lambda item: item["index"])
        return [list(item["embedding"]) for item in items]

    async def embed_query(self, text: str, instruction: str = "") -> list[float]:
        vectors = await self.embed([instruction + text] if instruction else [text])
        return vectors[0]


class TEIEmbeddings:
    """Клиент native API Text Embeddings Inference: POST {base_url}/embed."""

    def __init__(
        self,
        base_url: str,
        timeout: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as client:
            resp = await client.post(f"{self._base_url}/embed", json={"inputs": texts})
            resp.raise_for_status()
            data: Any = resp.json()
        if isinstance(data[0], (int, float)):
            return [list(data)]
        return [list(vec) for vec in data]

    async def embed_query(self, text: str, instruction: str = "") -> list[float]:
        vectors = await self.embed([instruction + text] if instruction else [text])
        return vectors[0]


class FakeEmbeddings:
    """Детерминированные L2-нормированные вектора: сумма word-seeded гауссиан.

    Тексты с общими словами получают близкие вектора — retrieval на них
    работает как лексический поиск. Детерминировано по (seed, слово).
    Инструкция игнорируется: fake-вектора не различают режимы.
    """

    def __init__(self, dim: int = EMBEDDING_DIM, seed: int = 7) -> None:
        self._dim = dim
        self._seed = seed

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(t) for t in texts]

    async def embed_query(self, text: str, instruction: str = "") -> list[float]:
        return self._one(text)

    def _one(self, text: str) -> list[float]:
        vec = [0.0] * self._dim
        words = _WORD.findall(text.lower()) or ["<empty>"]
        for word in words:
            digest = hashlib.sha256(f"{self._seed}:{word}".encode()).digest()
            rng = random.Random(int.from_bytes(digest, "big"))
            for i in range(self._dim):
                vec[i] += rng.gauss(0.0, 1.0)
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]


def build_embeddings(provider: str, base_url: str, model: str = "", timeout: float | None = None) -> Embeddings:
    """Провайдер по имени. base_url — адрес эмбеддинг-сервиса (для fake не нужен).

    timeout — таймаут запроса; None = дефолт клиента (длинный, для инжеста).
    Интерактивный путь (чат) передаёт короткий, чтобы лежащий сервис не держал
    запрос минутами.
    """
    if provider == "llamacpp":
        if timeout is None:
            return LlamaCppEmbeddings(base_url, model=model)
        return LlamaCppEmbeddings(base_url, model=model, timeout=timeout)
    if provider == "tei":
        if timeout is None:
            return TEIEmbeddings(base_url)
        return TEIEmbeddings(base_url, timeout=timeout)
    if provider == "fake":
        return FakeEmbeddings()
    raise ValueError(f"Неизвестный embeddings_provider: {provider!r} (жди 'fake', 'tei' или 'llamacpp')")
