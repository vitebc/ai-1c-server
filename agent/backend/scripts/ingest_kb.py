"""Инжест папки документов в RAG-хранилище (pgvector).

Скрипт обходит каталог с .md/.txt, режет на чанки, эмбеддит и кладёт в
таблицы documents/chunks. Документы идентифицируются по относительному пути
от корня папки — повторный прогон с --replace перезаписывает их, а не плодит
дубли.

Запуск (из каталога backend/):

    # dev
    uv run python scripts/ingest_kb.py --dir ../kb --replace

    # prod
    cd /home/test/.config/ai-1c-server/1c-chat/backend
    uv run python scripts/ingest_kb.py --dir /app/kb --replace

Ключи:
    --dir PATH         корень папки с документами (обязателен)
    --replace          удалить прежние документы этой коллекции перед заливкой
    --profile NAME     access_profile документов (по умолчанию 'all')
    --agent NAME       agent_name для RAG-изоляции (по умолчанию None — общие)
    --collection NAME  метка коллекции в source (по умолчанию — имя папки)
    --batch-size N     размер батча эмбеддингов (по умолчанию 32)
    --limit N          ограничить число файлов (для проверки)

Документы одной коллекции помечаются source='<collection>/<относительный путь>',
поэтому --replace удаляет ровно свою коллекцию и не трогает чужое.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from sqlalchemy import delete, select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker  # noqa: E402

from app.config import settings  # noqa: E402
from app.db.models import Chunk, Document  # noqa: E402
from app.db.session import SessionFactory  # noqa: E402
from app.rag.chunking import split_markdown  # noqa: E402
from app.rag.embeddings import Embeddings, build_embeddings  # noqa: E402

log = logging.getLogger("ingest_kb")

#: Расширения, которые грузим. PDF/DOCX — через Docling (отложено).
_TEXT_SUFFIXES = {".md", ".markdown", ".txt"}


def collect_files(root: Path, limit: int | None) -> list[Path]:
    """Файлы документов под корнем, отсортированные по пути (детерминированно)."""
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in _TEXT_SUFFIXES)
    if limit is not None:
        files = files[:limit]
    return files


def title_of(path: Path, text: str) -> str:
    """Заголовок документа: первый H1 из текста, иначе имя файла."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    return path.stem


#: Служебный заголовок страницы (первая строка выгрузки с its.1c.ru):
#: «<продукт> :: Информация об обновлениях…». Не несёт содержания — только
#: дублирует H1 и загрязняет выдачу поиска (604 чанка на 302 статьи).
_PAGE_TITLE_RE = re.compile(r"^.*::\s*Информация об обновлениях.*$", re.MULTILINE)

#: Оглавление статьи — список ссылок вида «* [Раздел](#anchor)». Тот же текст
#: повторяется в тысячах статей и тянет в выдачу любые запросы.
_TOC_LINE_RE = re.compile(r"^\s*[*+-]\s+\[[^\]]*\]\([^)]*\)\s*$", re.MULTILINE)

#: Ссылки на картинки: файлы изображений в корпусе не лежат, поэтому в
#: векторе остаётся только мусорный markdown.
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")


#: «Дата выхода релиза: DD.MM.YYYY» — метаданные статьи о релизе.
_RELEASE_DATE_RE = re.compile(r"^\s*Дата выхода релиза:.*$", re.MULTILINE)


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


async def ingest_one(
    path: Path,
    *,
    root: Path,
    collection: str,
    access_profile: str,
    agent_name: str | None,
    session_factory: async_sessionmaker[AsyncSession],
    embeddings: Embeddings,
    batch_size: int,
) -> tuple[int, int]:
    """Заливает один документ. Возвращает (число чанков, число документов)."""
    text = clean_markdown(path.read_text(encoding="utf-8", errors="replace"))
    chunks = split_markdown(text)
    title = title_of(path, text)
    # Чанк из одних метаданных релиза не несёт содержания, но вытесняет
    # его из выдачи по запросу «что нового в версии X».
    chunks = [c for c in chunks if not is_metadata_only(c, title)]
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


async def main() -> int:
    ap = argparse.ArgumentParser(description="Инжест папки документов в RAG-хранилище")
    ap.add_argument("--dir", required=True, help="корень папки с документами")
    ap.add_argument("--replace", action="store_true", help="перезаписать прежние документы коллекции")
    ap.add_argument("--profile", default="all", help="access_profile документов")
    ap.add_argument("--agent", default=None, help="agent_name (по умолчанию — общие документы)")
    ap.add_argument("--collection", default=None, help="метка коллекции (по умолчанию — имя папки)")
    ap.add_argument("--batch-size", type=int, default=32, help="размер батча эмбеддингов")
    ap.add_argument("--limit", type=int, default=None, help="ограничить число файлов")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    root = Path(args.dir).resolve()
    if not root.is_dir():
        log.error("не каталог: %s", root)
        return 2
    collection = args.collection or root.name
    files = collect_files(root, args.limit)
    if not files:
        log.error("в %s нет файлов .md/.txt", root)
        return 2

    embeddings = build_embeddings(settings.embeddings_provider, settings.embeddings_url, settings.embeddings_model)
    log.info(
        "коллекция=%s файлов=%d провайдер=%s dim-из-конфига",
        collection,
        len(files),
        settings.embeddings_provider,
    )

    if args.replace:
        removed = await purge_collection(SessionFactory, collection)
        log.info("удалено прежних документов коллекции: %d", removed)

    started = time.time()
    total_chunks = 0
    total_docs = 0
    for index, path in enumerate(files, start=1):
        chunks, docs = await ingest_one(
            path,
            root=root,
            collection=collection,
            access_profile=args.profile,
            agent_name=args.agent,
            session_factory=SessionFactory,
            embeddings=embeddings,
            batch_size=args.batch_size,
        )
        total_chunks += chunks
        total_docs += docs
        if index % 20 == 0 or index == len(files):
            log.info("%d/%d файлов, чанков=%d, %.1fs", index, len(files), total_chunks, time.time() - started)

    log.info("готово: документов=%d чанков=%d за %.1fs", total_docs, total_chunks, time.time() - started)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
