"""Инжест папки документов в RAG-хранилище (CLI).

Логика — в app/rag/corpus.py (общая с HTTP-API /rag/*), здесь только разбор
аргументов и запуск.

Запуск (из каталога backend/):

    # dev (хост; DATABASE_URL из ../.env — порт 5435)
    uv run python scripts/ingest_kb.py --dir ../kb --collection updinfo --replace

    # в контейнере (папка kb примонтирована в /app/kb)
    docker compose exec backend uv run python scripts/ingest_kb.py \
      --dir /app/kb --collection updinfo --replace

Ключи:
    --dir PATH         корень папки с документами (обязателен)
    --replace          удалить прежние документы этой коллекции перед заливкой
    --profile NAME     access_profile документов (по умолчанию 'all')
    --agent NAME       agent_name для RAG-изоляции (по умолчанию None — общие)
    --collection NAME  метка коллекции (по умолчанию — имя папки)
    --batch-size N     размер батча эмбеддингов (по умолчанию 32)
    --limit N          ограничить число файлов (для проверки)
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from app.config import settings  # noqa: E402
from app.db.session import SessionFactory  # noqa: E402
from app.rag.corpus import ingest_collection  # noqa: E402
from app.rag.embeddings import build_embeddings  # noqa: E402

log = logging.getLogger("ingest_kb")


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
    embeddings = build_embeddings(
        settings.embeddings_provider,
        settings.embeddings_url,
        settings.embeddings_model,
    )
    log.info("коллекция=%s каталог=%s провайдер=%s", collection, root, settings.embeddings_provider)

    started = time.time()
    result = await ingest_collection(
        root,
        collection=collection,
        access_profile=args.profile,
        agent_name=args.agent,
        session_factory=SessionFactory,
        embeddings=embeddings,
        batch_size=args.batch_size,
        replace=args.replace,
        limit=args.limit,
    )
    log.info(
        "готово: документов=%d чанков=%d удалено=%d пропущено=%d ошибок=%d за %.1fs",
        result.documents,
        result.chunks,
        result.removed,
        len(result.skipped),
        len(result.errors),
        time.time() - started,
    )
    for err in result.errors:
        log.warning("ошибка: %s", err)
    return 1 if result.errors else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
