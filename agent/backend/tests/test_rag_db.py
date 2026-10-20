"""Тесты инжеста и retrieval на живом postgres (нужен `up -d postgres`).

Пишут документы с префиксом TEST_ и удаляют за собой. Весь тест — один
asyncio.run (пул коннектов привязан к loop, см. conftest).

Fake-эмбеддинги случайны, поэтому запрос — ТОЧНЫЙ текст чанка из БД
(прочитан обратно): distance 0 всегда ранжируется первым. Это же делает
тест прав сильным: чанк с distance 0 чужой профиль увидеть не должен.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from sqlalchemy import delete, func, select

from app.db.models import Chunk, Document
from app.db.session import SessionFactory
from app.rag import FakeEmbeddings, ingest_file, retrieve

MARKER = "TEST_RAG_UNIKALNAYA_STROKA_42"


async def _scenario() -> None:
    path = Path("/tmp/test_rag_doc.md")
    path.write_text(f"# Тест\n\n{MARKER} находится именно здесь.\n", encoding="utf-8")
    try:
        emb = FakeEmbeddings()
        async with SessionFactory() as s:
            await s.execute(delete(Document).where(Document.source == str(path)))
            await s.commit()
        doc_id = await ingest_file(path, access_profile="sales", session_factory=SessionFactory, embeddings=emb)
        assert doc_id > 0

        async with SessionFactory() as s:
            chunk_text = (
                (await s.execute(select(Chunk.text).where(Chunk.document_id == doc_id).order_by(Chunk.position)))
                .scalars()
                .first()
            )
        assert chunk_text and MARKER in chunk_text

        async def search(profile: str) -> list[dict[str, str]]:
            return await retrieve(
                session_factory=SessionFactory,
                embeddings=emb,
                query=chunk_text,
                access_profile=profile,
                top_k=5,
            )

        # Точный текст чанка — первый результат.
        assert (await search("all"))[0]["text"] == chunk_text
        assert (await search("sales"))[0]["text"] == chunk_text
        # Чужой профиль не видит даже distance-0 чанк: фильтр в WHERE, не постфактум.
        assert all(MARKER not in r["text"] for r in await search("accounting"))

        async with SessionFactory() as s:
            n = await s.scalar(select(func.count()).select_from(Chunk).where(Chunk.document_id == doc_id))
            assert (n or 0) >= 1
    finally:
        async with SessionFactory() as s:
            await s.execute(delete(Document).where(Document.source == str(path)))
            await s.commit()
        path.unlink(missing_ok=True)


def test_ingest_and_retrieve_with_rights() -> None:
    asyncio.run(_scenario())


def test_header_chunk_expands_to_article_content() -> None:
    """Служебный чанк-заголовок разворачивается в содержание статьи.

    Номер версии есть только в заголовке, поэтому запрос «что нового в версии
    X» находит именно служебный чанк. Отдать его — значит отдать название без
    содержания, поэтому retrieval разворачивает его в содержательные чанки
    той же статьи.

    Служебный чанк кладёт scripts/ingest_kb.py (заголовок статьи отдельным
    чанком), поэтому здесь собираем документ вручную.
    """
    title = "Тестовая статья про версию 9.9.9"
    body = "MARKER_ПЕРВОЕ_ содержание статьи про версию."
    section = "MARKER_ВТОРОЕ_ содержание раздела."

    async def scenario() -> None:
        emb = FakeEmbeddings()
        async with SessionFactory() as s:
            await s.execute(delete(Document).where(Document.source == "/tmp/test_rag_header.md"))
            await s.commit()
        async with SessionFactory() as s:
            doc = Document(title=title, source="/tmp/test_rag_header.md", access_profile="all")
            s.add(doc)
            await s.flush()
            for position, text in enumerate((title, body, section)):
                s.add(
                    Chunk(
                        document_id=doc.id,
                        position=position,
                        text=text,
                        embedding=(await emb.embed([text]))[0],
                    )
                )
            await s.commit()
        try:
            rows = await retrieve(
                session_factory=SessionFactory,
                embeddings=emb,
                query=title,
                access_profile="all",
                top_k=5,
            )
            assert rows, "заголовок не найден"
            texts = [r["text"] for r in rows]
            # Вместе с заголовком пришло содержание той же статьи.
            assert any("MARKER_ПЕРВОЕ_" in t for t in texts), texts
            assert not all(t == title for t in texts), "вернулся только заголовок"
        finally:
            async with SessionFactory() as s:
                await s.execute(delete(Document).where(Document.source == "/tmp/test_rag_header.md"))
                await s.commit()

    asyncio.run(scenario())


def test_retrieve_min_score_filters_irrelevant() -> None:
    """min_score отсекает нерелевантное: у реальной модели косинус «просто
    русского текста» ~0.4-0.6, и без порога агент получал бы «мусор».
    """
    path = Path("/tmp/test_rag_threshold.md")
    path.write_text(f"# Тест\n\n{MARKER} находится именно здесь.\n", encoding="utf-8")

    async def scenario() -> None:
        emb = FakeEmbeddings()
        async with SessionFactory() as s:
            await s.execute(delete(Document).where(Document.source == str(path)))
            await s.commit()
        doc_id = await ingest_file(
            path, access_profile="all", session_factory=SessionFactory, embeddings=emb
        )
        try:
            async with SessionFactory() as s:
                chunk_text = (
                    (await s.execute(select(Chunk.text).where(Chunk.document_id == doc_id)))
                    .scalars()
                    .first()
                )
            assert chunk_text

            async def search(min_score: float, query: str) -> list[dict[str, str]]:
                return await retrieve(
                    session_factory=SessionFactory,
                    embeddings=emb,
                    query=query,
                    access_profile="all",
                    top_k=5,
                    min_score=min_score,
                )

            # Точный текст чанка: distance 0 → similarity 1.0, проходит любой порог.
            assert await search(0.99, chunk_text)
            # Посторонний текст: similarity ниже 0.9 → отсекается.
            assert not await search(0.99, "совершенно другой текст про апельсины")
            # Без порога (0) отсечки нет — возвращается лучший кандидат.
            assert await search(0.0, "совершенно другой текст про апельсины")
        finally:
            async with SessionFactory() as s:
                await s.execute(delete(Document).where(Document.source == str(path)))
                await s.commit()
            path.unlink(missing_ok=True)

    asyncio.run(scenario())
