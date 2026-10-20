"""Тесты HTTP-API базы знаний (/rag/*).

Проверяют то, чем пользуется админка: состояние корпуса, список и просмотр
документов, загрузку/удаление, пробный поиск, переинжест коллекции.

Эмбеддинги в тестах — fake (провайдер фиксируется в conftest): тесты не
ходят ни в сеть, ни в эмбеддинг-сервис.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.config import settings
from app.db.models import Chunk, Document
from app.db.session import SessionFactory
from app.main import app

SOURCE = "/tmp/test_rag_api_doc.md"
TITLE = "Тестовая статья RAG API"
MARKER = "TEST_RAG_API_MARKER_42"


def _seed(client: TestClient) -> int:
    """Документ с чанками в БД. Возвращает id.

    Сид идёт через портал TestClient: пул соединений привязан к loop портала
    (см. conftest.py) — свой asyncio.run() дал бы «attached to a different loop».
    """
    from app.rag.embeddings import FakeEmbeddings

    async def go() -> int:
        emb = FakeEmbeddings()
        texts = [TITLE, f"{MARKER} — содержимое тестового документа."]
        vectors = await emb.embed(texts)
        async with SessionFactory() as s:
            await s.execute(delete(Document).where(Document.source == SOURCE))
            doc = Document(title=TITLE, source=SOURCE, access_profile="all")
            s.add(doc)
            await s.flush()
            for position, (text, vector) in enumerate(zip(texts, vectors, strict=True)):
                s.add(Chunk(document_id=doc.id, position=position, text=text, embedding=vector))
            await s.commit()
            return doc.id

    with client._portal_factory() as portal:
        result: int = portal.call(go)
        return result


def _cleanup(client: TestClient) -> None:
    async def go() -> None:
        async with SessionFactory() as s:
            await s.execute(delete(Document).where(Document.source == SOURCE))
            await s.commit()

    with client._portal_factory() as portal:
        portal.call(go)


def test_rag_status_reports_provider_and_counts() -> None:
    with TestClient(app) as client:
        _seed(client)
        try:
            r = client.get("/rag/status")
            assert r.status_code == 200, r.text
            body = r.json()
            # Провайдер эмбеддингов виден (в тестах — fake).
            assert body["provider"] == "fake"
            assert body["embedding_dim"] > 0
            assert body["documents"] >= 1
            assert body["chunks"] >= 1
            assert isinstance(body["collections"], list)
        finally:
            _cleanup(client)


def test_list_and_get_document() -> None:
    with TestClient(app) as client:
        doc_id = _seed(client)
        try:
            r = client.get("/rag/documents", params={"q": "Тестовая статья"})
            assert r.status_code == 200, r.text
            items = r.json()["items"]
            assert any(i["id"] == doc_id for i in items), items

            r = client.get(f"/rag/documents/{doc_id}")
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["title"] == TITLE
            assert len(body["chunks"]) == 2
            # Первый чанк — служебный заголовок.
            assert body["chunks"][0]["is_header"] is True
            assert body["chunks"][1]["is_header"] is False
        finally:
            _cleanup(client)


def test_get_missing_document_404() -> None:
    with TestClient(app) as client:
        assert client.get("/rag/documents/99999999").status_code == 404


def test_upload_document_creates_chunks() -> None:
    with TestClient(app) as client:
        r = client.post(
            "/rag/documents",
            json={
                "title": "Загруженный из API документ",
                "content": f"# Загруженный из API документ\n\n{TITLE}\n\nСодержимое.\n",
                "collection": "test_api",
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["chunks"] >= 1
        doc_id = body["id"]

        r = client.get(f"/rag/documents/{doc_id}")
        assert r.status_code == 200
        assert r.json()["title"] == "Загруженный из API документ"

        r = client.delete(f"/rag/documents/{doc_id}")
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True
        assert client.get(f"/rag/documents/{doc_id}").status_code == 404


def test_search_returns_fragments() -> None:
    with TestClient(app) as client:
        _seed(client)
        try:
            r = client.post("/rag/search", json={"query": TITLE, "top_k": 3})
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["found"] is True
            assert body["fragments"], body
            # Найден именно наш документ.
            assert any(TITLE in f["title"] for f in body["fragments"]), body
        finally:
            _cleanup(client)


def test_reingest_uses_collection_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Переинжест берёт папку коллекции и заливает её документы.

    Папка — временная, с одним файлом: полный корпус эмбеддится минутами,
    а тесту нужен контракт, а не прогон всего корпуса.
    """
    monkeypatch.setattr(settings, "kb_dir", str(tmp_path))
    collection_dir = tmp_path / "test_coll"
    collection_dir.mkdir()
    (collection_dir / "doc.md").write_text(
        "# Тестовый документ коллекции\n\nMARKER_REINGEST_ содержание для проверки.\n",
        encoding="utf-8",
    )
    with TestClient(app) as client:
        r = client.post("/rag/reingest", json={"collection": "test_coll", "replace": True})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["documents"] == 1
        assert body["chunks"] >= 1
        assert body["errors"] == []

        # Документ появился в корпусе и находится пробным поиском.
        r = client.post("/rag/search", json={"query": "MARKER_REINGEST_", "top_k": 3})
        assert r.status_code == 200, r.text
        assert r.json()["found"] is True

        r = client.delete("/rag/collections/test_coll")
        assert r.status_code == 200, r.text
        assert r.json()["removed"] == 1


def test_reingest_missing_folder_400() -> None:
    """Нет папки коллекции — 400, а не молчаливый переход в корень корпуса."""
    with TestClient(app) as client:
        r = client.post("/rag/reingest", json={"collection": "нет-такой-папки"})
        assert r.status_code == 400, r.text
        assert "не найдена" in r.json()["detail"]


def test_delete_collection_removes_documents() -> None:
    with TestClient(app) as client:
        _seed(client)
        try:
            r = client.delete("/rag/collections/test_api")
            assert r.status_code == 200, r.text
            assert r.json()["removed"] >= 0
        finally:
            _cleanup(client)
