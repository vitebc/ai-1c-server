"""HTTP-API базы знаний: /rag/*.

Управление корпусом из админки (Rust-прокси → сюда):

  GET    /rag/status              — состояние: провайдер, размерность, счётчики
  GET    /rag/documents           — список документов (поиск, коллекция, пагинация)
  GET    /rag/documents/{id}      — документ с его чанками (предпросмотр)
  DELETE /rag/documents/{id}      — удалить документ с чанками
  POST   /rag/documents           — загрузить/перезаписать документ (markdown)
  POST   /rag/search              — пробный поиск по базе знаний (как увидит агент)
  POST   /rag/reingest            — переинжест коллекции из папки
  DELETE /rag/collections/{name}  — удалить коллекцию целиком

Как и остальные эндпоинты бэкенда — без авторизации (закрытый контур,
админка ходит сюда через свой прокси).

Инжест из API идёт по той же папке, что и CLI (KB_ROOT), и тем же кодом
(app.rag.corpus), поэтому состояние БД и каталога не расходятся.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from app.config import settings
from app.db.models import Chunk, Document
from app.db.session import SessionFactory
from app.rag.corpus import (
    build_chunks,
    clean_markdown,
    corpus_summary,
    ingest_collection,
    purge_collection,
)
from app.rag.embeddings import Embeddings, build_embeddings
from app.rag.retrieval import retrieve

log = logging.getLogger("agent1c.api.rag")

router = APIRouter(prefix="/rag", tags=["rag"])


def _kb_root() -> Path:
    """Корень папки с корпусом.

    В контейнере — /app/kb (папка примонтирована compose'ом). На хосте (запуск
    вне контейнера, напр. uv run в backend/) — kb рядом с backend/. Явная
    настройка KB_DIR важнее обоих вариантов.
    """
    raw = settings.kb_dir.strip()
    if raw:
        return Path(raw).resolve()
    container = Path("/app/kb")
    if container.is_dir():
        return container
    # backend/src/app/api/rag.py -> agent/kb (родитель backend/)
    return (Path(__file__).resolve().parents[4] / "kb").resolve()


def _embeddings() -> Embeddings:
    return build_embeddings(
        settings.embeddings_provider,
        settings.embeddings_url,
        settings.embeddings_model,
    )


class DocumentIn(BaseModel):
    """Документ для загрузки."""

    title: str = Field(min_length=1, max_length=512)
    content: str = Field(min_length=1)
    collection: str = Field(default="manual", min_length=1, max_length=64)
    access_profile: str = Field(default="all", min_length=1, max_length=64)
    agent_name: str | None = Field(default=None, max_length=64)
    filename: str | None = Field(default=None, max_length=256)


class SearchIn(BaseModel):
    """Пробный поиск по базе знаний."""

    query: str = Field(min_length=2)
    top_k: int = Field(default=5, ge=1, le=10)
    access_profile: str = Field(default="all", min_length=1, max_length=64)
    agent_name: str | None = Field(default=None, max_length=64)
    min_score: float | None = Field(default=None, ge=0.0, le=1.0)


class ReingestIn(BaseModel):
    """Переинжест коллекции из папки."""

    collection: str = Field(default="updinfo", min_length=1, max_length=64)
    replace: bool = True
    profile: str = Field(default="all", min_length=1, max_length=64)
    agent: str | None = Field(default=None, max_length=64)
    limit: int | None = Field(default=None, ge=1, le=1000)


@router.get("/status")
async def rag_status() -> dict[str, object]:
    """Состояние базы знаний: провайдер эмбеддингов и счётчики по корпусу."""
    from app.db.models import EMBEDDING_DIM

    summary = await corpus_summary(SessionFactory)
    return {
        "provider": settings.embeddings_provider,
        "base_url": settings.embeddings_url,
        "model": settings.embeddings_model,
        "embedding_dim": EMBEDDING_DIM,
        "kb_dir": str(_kb_root()),
        "kb_dir_exists": _kb_root().is_dir(),
        "skill_match_threshold": settings.skill_match_threshold_value,
        "kb_min_score": settings.kb_min_score_value,
        **summary,
    }


@router.get("/documents")
async def list_documents(
    q: str | None = Query(default=None, max_length=256, description="Поиск по названию"),
    collection: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict[str, object]:
    """Список документов корпуса с обрезкой по коллекции и поиском по названию."""
    stmt = select(
        Document.id,
        Document.title,
        Document.source,
        Document.access_profile,
        Document.agent_name,
        func.count(Chunk.id).label("chunks"),
    ).join(Chunk, Chunk.document_id == Document.id)
    if collection:
        stmt = stmt.where(Document.source.like(f"{collection}/%"))
    if q:
        stmt = stmt.where(Document.title.ilike(f"%{q}%"))
    stmt = stmt.group_by(Document.id).order_by(Document.title).limit(limit).offset(offset)

    async with SessionFactory() as session:
        rows = (await session.execute(stmt)).all()
        total = (await session.execute(select(func.count()).select_from(Document))).scalar() or 0
    return {
        "total": total,
        "items": [
            {
                "id": doc_id,
                "title": title,
                "source": source,
                "access_profile": access_profile,
                "agent_name": agent_name,
                "chunks": chunks,
            }
            for doc_id, title, source, access_profile, agent_name, chunks in rows
        ],
    }


@router.get("/documents/{document_id}")
async def get_document(document_id: int) -> dict[str, object]:
    """Документ с чанками — предпросмотр того, что уходит в вектор."""
    async with SessionFactory() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="документ не найден")
        chunks = (
            await session.execute(
                select(Chunk.id, Chunk.position, Chunk.text)
                .where(Chunk.document_id == document_id)
                .order_by(Chunk.position)
            )
        ).all()
    return {
        "id": doc.id,
        "title": doc.title,
        "source": doc.source,
        "access_profile": doc.access_profile,
        "agent_name": doc.agent_name,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "chunks": [
            {"id": cid, "position": pos, "text": text, "is_header": pos == 0 and text == doc.title}
            for cid, pos, text in chunks
        ],
    }


@router.delete("/documents/{document_id}")
async def delete_document(document_id: int) -> dict[str, object]:
    """Удаляет документ вместе с чанками."""
    async with SessionFactory() as session:
        doc = await session.get(Document, document_id)
        if doc is None:
            raise HTTPException(status_code=404, detail="документ не найден")
        await session.execute(delete(Chunk).where(Chunk.document_id == document_id))
        await session.execute(delete(Document).where(Document.id == document_id))
        await session.commit()
    return {"ok": True, "deleted": document_id}


@router.post("/documents")
async def upload_document(body: DocumentIn) -> dict[str, object]:
    """Загружает документ (markdown) в корпус: чистит, режет и эмбеддит.

    Тот же путь, что у CLI-инжеста, — состояние БД и каталога не расходится.
    """
    text = clean_markdown(body.content)
    title = body.title.strip()
    chunks = build_chunks(text, title)
    if not chunks:
        raise HTTPException(status_code=400, detail="после чистки не осталось текста")

    vectors = await _embeddings().embed(chunks)
    source = f"{body.collection}/{body.filename or title}.md"
    async with SessionFactory() as session:
        # Перезапись документа с тем же source (документ мог быть загружен ранее).
        old = (await session.execute(select(Document.id).where(Document.source == source))).scalars().all()
        if old:
            await session.execute(delete(Chunk).where(Chunk.document_id.in_(old)))
            await session.execute(delete(Document).where(Document.id.in_(old)))
        doc = Document(
            title=title,
            source=source,
            access_profile=body.access_profile,
            agent_name=body.agent_name,
        )
        session.add(doc)
        await session.flush()
        for position, (chunk_text, vector) in enumerate(zip(chunks, vectors, strict=True)):
            session.add(Chunk(document_id=doc.id, position=position, text=chunk_text, embedding=vector))
        await session.commit()
        doc_id = doc.id
    return {"ok": True, "id": doc_id, "title": title, "chunks": len(chunks), "source": source}


@router.post("/search")
async def search(body: SearchIn) -> dict[str, object]:
    """Пробный поиск по базе знаний — ровно то, что увидит агент."""
    min_score = settings.kb_min_score_value if body.min_score is None else body.min_score
    rows = await retrieve(
        session_factory=SessionFactory,
        embeddings=_embeddings(),
        query=body.query,
        access_profile=body.access_profile,
        top_k=body.top_k,
        agent_name=body.agent_name or "",
        min_score=min_score,
    )
    return {"query": body.query, "min_score": min_score, "found": bool(rows), "fragments": rows}


@router.post("/reingest")
async def reingest(body: ReingestIn) -> dict[str, object]:
    """Переинжест коллекции из папки корпуса (KB_DIR).

    Каждая коллекция — своя подпапка в корне корпуса. Если её нет —
    ошибка: молчаливый переход в корень залил бы весь корпус (и занял бы
    минуты эмбеддинга).
    """
    root = _kb_root()
    if not root.is_dir():
        raise HTTPException(status_code=400, detail=f"папка корпуса не найдена: {root}")
    collection_dir = root / body.collection
    if not collection_dir.is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"папка коллекции не найдена: {collection_dir}",
        )
    result = await ingest_collection(
        collection_dir,
        collection=body.collection,
        access_profile=body.profile,
        agent_name=body.agent,
        session_factory=SessionFactory,
        embeddings=_embeddings(),
        replace=body.replace,
        limit=body.limit,
    )
    return {"ok": not result.errors, **result.as_dict()}


@router.delete("/collections/{name}")
async def delete_collection(name: str) -> dict[str, object]:
    """Удаляет коллекцию целиком (документы и чанки)."""
    removed = await purge_collection(SessionFactory, name)
    return {"ok": True, "collection": name, "removed": removed}
