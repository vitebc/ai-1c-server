"""RAG: переход на размерность 2560 (Qwen3-Embedding-4B).

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-20

Старая модель давала 1024 измерения (deepvk/USER-bge-m3), новая — 2560.
Векторы разной размерности несовместимы, поэтому колонка пересоздаётся,
а данные документов чистятся: переинжест выполнит скрипт ingest_kb.py.

Почему без индекса: pgvector не строит HNSW/IVFFlat на vector(N) при N > 2000.
Вариант halfvec(2560) индекс поддерживает, но теряет точность (fp16) и требует
другого типа колонки — при текущем объёме корпуса точный cosine-скан быстрее.
"""

from __future__ import annotations

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | tuple[str, None] | None = None
depends_on: str | tuple[str, None] | None = None


def upgrade() -> None:
    # Документы и чанки — производные данные (переинжест восстановит их).
    op.execute("DELETE FROM chunks")
    op.execute("DELETE FROM documents")
    # Пересоздаём колонку: pgvector не умеет менять размерность vector(N) на месте.
    op.execute("ALTER TABLE chunks DROP COLUMN embedding")
    op.execute("ALTER TABLE chunks ADD COLUMN embedding vector(2560) NOT NULL")


def downgrade() -> None:
    op.execute("DELETE FROM chunks")
    op.execute("DELETE FROM documents")
    op.execute("ALTER TABLE chunks DROP COLUMN embedding")
    op.execute("ALTER TABLE chunks ADD COLUMN embedding vector(1024) NOT NULL")
