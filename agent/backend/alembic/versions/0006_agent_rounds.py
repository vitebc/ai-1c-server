"""Раунды агентской петли: таблица agent_rounds.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-20

Хранит каждый раунд /chat (шаг LLM + вызовы инструментов) для просмотра в
админке: assistant-текст каждого шага и tool-call с аргументами/результатом.
Заполняется бэкендом по ходу петли (app.agent.loop), чтение — GET
/sessions/{id}/rounds. Ошибка записи не влияет на чат.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | tuple[str, ...] | None = None
depends_on: str | tuple[str, ...] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_rounds",
        sa.Column("id", sa.Integer(), primary_key=True),
        # Индекс создаётся отдельно (CREATE INDEX CONCURRENT-совместимый синтаксис).
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("request_id", sa.Integer(), nullable=True),
        sa.Column("round_no", sa.Integer(), nullable=False),
        sa.Column("step", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "role",
            sa.String(16),
            nullable=False,
            comment="assistant | tool (шаг LLM или ответ инструмента)",
        ),
        sa.Column("tool_name", sa.String(256), nullable=True),
        sa.Column("tool_args", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("is_error", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_agent_rounds_session_id", "agent_rounds", ["session_id"])


def downgrade() -> None:
    op.drop_index("ix_agent_rounds_session_id", table_name="agent_rounds")
    op.drop_table("agent_rounds")
