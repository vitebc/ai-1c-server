"""GET /sessions и GET /sessions/{id}/messages — просмотр диалогов.

Без авторизации (закрытый контур, как остальной API бэкенда). Ответы агента
хранятся в tables `sessions`/`messages` (см. app/db/models.py) — здесь только
чтение: история для отладки и аудита, источник — те же записи, что питает
контекст чата.

GET /stats/requests уже отдаёт вопрос+ответ одного обращения; эти эндпоинты
дают весь диалог сессии целиком (все раунды user/assistant).
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import desc, func, select

from app.db.models import ChatSession, Message, User
from app.db.session import SessionFactory

router = APIRouter(tags=["sessions"])


def _strip_tz(dt: datetime | None) -> datetime | None:
    """Колонка TIMESTAMP WITHOUT TIME ZONE — снимаем tzinfo (как в stats.py)."""
    if dt is not None and dt.tzinfo is not None:
        return dt.replace(tzinfo=None)
    return dt


@router.get("/sessions")
async def list_sessions(
    user_id: str | None = Query(default=None, max_length=128),
    base_name: str | None = Query(default=None, max_length=128),
    agent: str | None = Query(default=None, max_length=64),
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict:
    """Список диалогов с фильтрами и пагинацией (новые сверху).

    user_id — onec_id пользователя 1С (таблица users); agent — имя рантайм-агента.
    from/to — по дате создания сессии.
    """
    from_ = _strip_tz(from_)
    to = _strip_tz(to)

    async with SessionFactory() as s:
        q = (
            select(
                ChatSession,
                User.onec_id,
                User.display_name,
                func.count(Message.id),
                func.max(Message.created_at),
            )
            .join(User, ChatSession.user_id == User.id)
            .outerjoin(Message, Message.session_id == ChatSession.id)
            .group_by(ChatSession.id, User.onec_id, User.display_name)
        )
        if user_id:
            q = q.where(User.onec_id == user_id)
        if base_name:
            q = q.where(ChatSession.base_name == base_name)
        if agent:
            q = q.where(ChatSession.agent_name == agent)
        if from_:
            q = q.where(ChatSession.created_at >= from_)
        if to:
            q = q.where(ChatSession.created_at <= to)

        total = (await s.execute(select(func.count()).select_from(q.subquery()))).scalar() or 0

        rows = (
            await s.execute(
                q.order_by(desc(func.max(Message.created_at)), desc(ChatSession.id)).limit(limit).offset(offset)
            )
        ).all()

        items = [
            {
                "id": sess.id,
                "user_id": onec_id,
                "display_name": display or "",
                "base_name": sess.base_name,
                "agent_name": sess.agent_name,
                "skill_name": sess.skill_name,
                "title": sess.title,
                "created_at": sess.created_at.isoformat() if sess.created_at else None,
                "last_message_at": last_at.isoformat() if last_at else None,
                "message_count": count,
            }
            for sess, onec_id, display, count, last_at in rows
        ]

    return {"total": total, "items": items}


@router.get("/sessions/{session_id}/messages")
async def session_messages(
    session_id: int,
    limit: int = Query(default=200, ge=1, le=2000),
) -> dict:
    """Полная история диалога (user/assistant, хронологически).

    limit — последние N сообщений (дефолт 200): длинные сессии не тащат весь
    контекст одним ответом. 404 — сессия не найдена.
    """
    async with SessionFactory() as s:
        row = (
            await s.execute(
                select(ChatSession, User.onec_id)
                .join(User, ChatSession.user_id == User.id)
                .where(ChatSession.id == session_id)
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail=f"session not found: {session_id}")
        sess, onec_id = row

        # Последние limit сообщений, затем разворот в хронологический порядок.
        msg_rows = (
            (
                await s.execute(
                    select(Message).where(Message.session_id == session_id).order_by(Message.id.desc()).limit(limit)
                )
            )
            .scalars()
            .all()
        )
        messages = [
            {"role": m.role, "content": m.content, "created_at": m.created_at.isoformat() if m.created_at else None}
            for m in reversed(msg_rows)
        ]

    return {
        "session": {
            "id": sess.id,
            "user_id": onec_id,
            "base_name": sess.base_name,
            "agent_name": sess.agent_name,
            "skill_name": sess.skill_name,
            "title": sess.title,
            "created_at": sess.created_at.isoformat() if sess.created_at else None,
        },
        "messages": messages,
    }
