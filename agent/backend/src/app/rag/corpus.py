"""Корпус базы знаний: чистка документов, инжест, сводка по состоянию.

Общий код для CLI-скрипта scripts/ingest_kb.py и HTTP-API /rag/* — иначе
разъедутся: скрипт чистит мусор выгрузки, а API показывал бы «сырое» состояние.

Понятия:
  коллекция — логическое имя группы документов ('updinfo'); хранится в
  documents.source как префикс 'updinfo/<относительный путь>';
  служебный чанк — заголовок статьи (с номером версии), кладётся первым:
  номер версии есть только в заголовке, и без него запрос «что нового
  в версии X» находит соседние релизы.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import Chunk, Document
from app.rag.chunking import split_markdown
from app.rag.embeddings import Embeddings

log = logging.getLogger("agent1c.rag.corpus")

#: Ключ advisory-lock в Postgres: защита от параллельных инжестов.
#: Два одновременных --replace вытесняют документы друг друга.
_LOCK_ID = 80231

#: Расширения, которые грузим. PDF/DOCX — через Docling (отложено).
TEXT_SUFFIXES = {".md", ".markdown", ".txt"}

#: Служебный заголовок страницы (первая строка выгрузки с its.1c.ru):
#: «<продукт> :: Информация об обновлениях…». Не несёт содержания — только
#: дублирует H1 и загрязняет выдачу поиска.
_PAGE_TITLE_RE = re.compile(r"^.*::\s*Информация об обновлениях.*$", re.MULTILINE)

#: Оглавление статьи — список ссылок вида «* [Раздел](#anchor)». Тот же текст
#: повторяется в тысячах статей и тянет в выдачу любые запросы.
_TOC_LINE_RE = re.compile(r"^\s*[*+-]\s+\[[^\]]*\]\([^)]*\)\s*$", re.MULTILINE)

#: Ссылки на картинки: файлы изображений в корпусе не лежат, поэтому в
#: векторе остаётся только мусорный markdown.
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")

#: «Дата выхода релиза: DD.MM.YYYY» — метаданные статьи о релизе.
_RELEASE_DATE_RE = re.compile(r"^\s*Дата выхода релиза:.*$", re.MULTILINE)


def clean_markdown(text: str) -> str:
    """Убирает из статьи служебный мусор выгрузки its.1c.ru.

    Заголовок страницы, оглавление и битые ссылки на картинки. Содержание
    разделов не трогаем — только то, что мешает поиску.
    """
    text = _PAGE_TITLE_RE.sub("", text)
    text = _TOC_LINE_RE.sub("", text)
    text = _IMAGE_RE.sub("", text)
    # Схлопываем пустые строки, оставшиеся от вырезанных блоков.
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def is_metadata_only(chunk: str, title: str) -> bool:
    """Чанк состоит только из метаданных релиза (заголовок + дата выхода).

    Такой чанк не несёт содержания, но на запрос «что нового в версии X»
    он идеально совпадает по названию версии и занимает первые позиции
    выдачи — вытесняя само содержание релиза. Следующий чанк начинается
    с этого же текста (перекрытие), поэтому метаданные не теряются.
    """
    stripped = _RELEASE_DATE_RE.sub("", chunk)
    # Заголовок статьи приходит без «# » (это уже markdown-заголовок).
    if title:
        stripped = stripped.replace(title, "")
    stripped = re.sub(r"^#+\s+.*$", "", stripped, flags=re.MULTILINE)
    return not stripped.strip()


def title_of(path: Path, text: str) -> str:
    """Заголовок документа: первый H1 из текста, иначе имя файла."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    return path.stem


def collect_files(root: Path, limit: int | None = None) -> list[Path]:
    """Файлы документов под корнем, отсортированные по пути (детерминированно)."""
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES)
    if limit is not None:
        files = files[:limit]
    return files


def count_files(root: Path) -> int:
    """Число файлов документов под корнем (без лимита, для сверки с БД)."""
    return sum(1 for p in root.rglob("*") if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES)


def build_chunks(text: str, title: str) -> list[str]:
    """Чанки документа: заголовок (служебный) + содержательные.

    Заголовок статьи кладём ОТДЕЛЬНЫМ служебным чанком, а не в каждый:
    тогда запрос «что нового в версии 2.6.1.64» находит нужный релиз
    (номер версии есть только в заголовке), и при этом разнообразие
    выдачи не падает — обычные чанки остаются чистыми.

    Замер (корпус 300 статей): top1 0.641 против 0.605 у варианта
    «заголовок в каждом чанке», разных статей в top-5: 5/5 против 4/5.
    """
    chunks = [c for c in split_markdown(text) if not is_metadata_only(c, title)]
    if title:
        chunks = [title, *chunks]
    return chunks


@dataclass
class IngestResult:
    """Итог инжеста папки."""

    collection: str
    files: int = 0
    documents: int = 0
    chunks: int = 0
    removed: int = 0
    skipped: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "collection": self.collection,
            "files": self.files,
            "documents": self.documents,
            "chunks": self.chunks,
            "removed": self.removed,
            "skipped": self.skipped[:20],
            "errors": self.errors[:20],
        }


async def purge_collection(
    session_factory: async_sessionmaker[AsyncSession],
    collection: str,
) -> int:
    """Удаляет документы коллекции (source LIKE 'collection/%')."""
    pattern = f"{collection}/%"
    async with session_factory() as session:
        ids = (await session.execute(select(Document.id).where(Document.source.like(pattern)))).scalars().all()
        if not ids:
            return 0
        await session.execute(delete(Chunk).where(Chunk.document_id.in_(ids)))
        await session.execute(delete(Document).where(Document.id.in_(ids)))
        await session.commit()
    return len(ids)


async def ingest_document(
    path: Path,
    *,
    root: Path,
    collection: str,
    access_profile: str,
    agent_name: str | None,
    session_factory: async_sessionmaker[AsyncSession],
    embeddings: Embeddings,
    batch_size: int = 32,
) -> tuple[int, int]:
    """Заливает один документ. Возвращает (число чанков, число документов)."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    text = clean_markdown(raw)
    title = title_of(path, text)
    chunks = build_chunks(text, title)
    if not chunks:
        log.warning("нет текста для инжеста, пропускаю: %s", path)
        return 0, 0
    source = f"{collection}/{path.relative_to(root).as_posix()}"

    vectors: list[list[float]] = []
    for i in range(0, len(chunks), batch_size):
        vectors.extend(await embeddings.embed(chunks[i : i + batch_size]))

    async with session_factory() as session:
        doc = Document(
            title=title,
            source=source,
            access_profile=access_profile,
            agent_name=agent_name,
        )
        session.add(doc)
        await session.flush()
        for position, (chunk_text, vector) in enumerate(zip(chunks, vectors, strict=True)):
            session.add(Chunk(document_id=doc.id, position=position, text=chunk_text, embedding=vector))
        await session.commit()
    return len(chunks), 1


async def ingest_collection(
    root: Path,
    *,
    collection: str,
    access_profile: str = "all",
    agent_name: str | None = None,
    session_factory: async_sessionmaker[AsyncSession],
    embeddings: Embeddings,
    batch_size: int = 32,
    replace: bool = False,
    limit: int | None = None,
) -> IngestResult:
    """Инжестит папку документов в коллекцию.

    replace=True — сначала удаляет прежние документы коллекции (повторный
    прогон не плодит дубли).

    Параллельные прогоны заблокированы: без этого два одновременных
    --replace вытесняют документы друг друга и на выходе остаётся каша.
    """
    result = IngestResult(collection=collection)
    files = collect_files(root, limit)
    result.files = len(files)
    async with session_factory() as session:
        # pg_advisory_lock — блокировка на уровне БД: держим её до конца
        # инжеста. Блокировка привязана к СОЕДИНЕНИЮ, а не к транзакции, и
        # переживает commit — поэтому берём отдельное соединение из пула и
        # держим его открытым: иначе соединение вернулось бы в пул вместе
        # с блокировкой и она «залипла» бы на чужом сеансе.
        connection = await session.connection()
        try:
            await connection.execute(select(func.pg_advisory_lock(_LOCK_ID)))
            if replace:
                result.removed = await purge_collection(session_factory, collection)
            for path in files:
                try:
                    chunks, docs = await ingest_document(
                        path,
                        root=root,
                        collection=collection,
                        access_profile=access_profile,
                        agent_name=agent_name,
                        session_factory=session_factory,
                        embeddings=embeddings,
                        batch_size=batch_size,
                    )
                except Exception as e:  # noqa: BLE001 — один битый файл не роняет папку
                    log.warning("ошибка инжеста %s: %s", path, e)
                    result.errors.append(f"{path.name}: {e}")
                    continue
                if not docs:
                    result.skipped.append(path.name)
                    continue
                result.chunks += chunks
                result.documents += docs
        finally:
            await connection.execute(select(func.pg_advisory_unlock(_LOCK_ID)))
            await connection.close()
    return result


async def corpus_summary(
    session_factory: async_sessionmaker[AsyncSession],
) -> dict[str, object]:
    """Сводка по корпусу: сколько документов/чанков и по коллекциям."""
    async with session_factory() as session:
        total_docs = (await session.execute(select(func.count()).select_from(Document))).scalar() or 0
        total_chunks = (await session.execute(select(func.count()).select_from(Chunk))).scalar() or 0
        rows = (
            await session.execute(
                select(Document.source, func.count(Chunk.id))
                .join(Chunk, Chunk.document_id == Document.id)
                .group_by(Document.source)
            )
        ).all()
    by_collection: dict[str, dict[str, int]] = {}
    for source, chunks in rows:
        collection = source.split("/", 1)[0] if "/" in source else "(без коллекции)"
        entry = by_collection.setdefault(collection, {"documents": 0, "chunks": 0})
        entry["documents"] += 1
        entry["chunks"] += chunks
    return {
        "documents": total_docs,
        "chunks": total_chunks,
        "collections": [
            {"name": name, "documents": data["documents"], "chunks": data["chunks"]}
            for name, data in sorted(by_collection.items())
        ],
    }
