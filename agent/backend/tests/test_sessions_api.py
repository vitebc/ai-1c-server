"""Тесты GET /sessions и GET /sessions/{id}/messages — просмотр диалогов."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.db.models import ChatSession, Message, User
from app.db.session import SessionFactory
from app.main import app


def _seed(client: TestClient) -> tuple[int, int]:
    """Тестовый пользователь + две сессии с сообщениями (в loop портала TestClient).

    Возвращает (user_pk, session_a). Пул коннектов привязан к loop портала —
    поэтому и сид, и cleanup идут через client.portal_factory (см. conftest.py).
    """

    async def go() -> tuple[int, int, int]:
        async with SessionFactory() as s:
            user = User(onec_id="sess-test-u1", display_name="Тест Сессий")
            s.add(user)
            await s.flush()
            sess_a = ChatSession(user_id=user.id, base_name="ca2_ai", agent_name="assistant", title="Диалог A")
            sess_b = ChatSession(user_id=user.id, base_name="doc3_test", agent_name="analyst")
            s.add_all([sess_a, sess_b])
            await s.flush()
            s.add_all(
                [
                    Message(session_id=sess_a.id, role="user", content="сколько стульев?"),
                    Message(session_id=sess_a.id, role="assistant", content="Стульев: **10**."),
                    Message(session_id=sess_b.id, role="user", content="остатки по складам"),
                ]
            )
            await s.commit()
            return user.id, sess_a.id, sess_b.id

    with client._portal_factory() as portal:
        return portal.call(go)


def _cleanup(client: TestClient, user_pk: int) -> None:
    async def go() -> None:
        async with SessionFactory() as s:
            user = await s.get(User, user_pk)
            if user is not None:
                await s.delete(user)  # sessions/messages — ON DELETE CASCADE в БД
                await s.commit()

    with client._portal_factory() as portal:
        portal.call(go)


def test_list_sessions_and_messages() -> None:
    with TestClient(app) as client:
        user_pk, sess_a, sess_b = _seed(client)
        try:
            r = client.get("/sessions")
            assert r.status_code == 200, r.text
            body = r.json()
            ids = [it["id"] for it in body["items"]]
            assert sess_a in ids
            item = next(it for it in body["items"] if it["id"] == sess_a)
            assert item["user_id"] == "sess-test-u1"
            assert item["display_name"] == "Тест Сессий"
            assert item["base_name"] == "ca2_ai"
            assert item["agent_name"] == "assistant"
            assert item["message_count"] == 2

            # Фильтр по пользователю (onec_id).
            r = client.get("/sessions", params={"user_id": "sess-test-u1"})
            assert all(it["user_id"] == "sess-test-u1" for it in r.json()["items"])
            r = client.get("/sessions", params={"user_id": "nobody"})
            assert r.json()["total"] == 0

            # Фильтр по базе. В БД могут быть чужие сессии с той же базой
            # (реальные пользователи), поэтому проверяем состав выдачи, а не
            # абсолютное количество.
            r = client.get("/sessions", params={"base_name": "doc3_test"})
            items = r.json()["items"]
            assert items, "сессия с базой doc3_test не найдена"
            assert all(it["base_name"] == "doc3_test" for it in items)
            assert sess_b in [it["id"] for it in items]

            # История диалога: роль, порядок, контент.
            r = client.get(f"/sessions/{sess_a}/messages")
            assert r.status_code == 200, r.text
            mbody = r.json()
            assert mbody["session"]["id"] == sess_a
            assert [m["role"] for m in mbody["messages"]] == ["user", "assistant"]
            assert mbody["messages"][1]["content"] == "Стульев: **10**."

            # 404 на несуществующую сессию.
            r = client.get("/sessions/999999/messages")
            assert r.status_code == 404
        finally:
            _cleanup(client, user_pk)


def test_messages_limit_returns_last_n() -> None:
    with TestClient(app) as client:
        user_pk, sess_a, sess_b = _seed(client)
        try:
            # В сессию A докидываем ещё сообщения — limit=2 даст только последние.

            async def go(sess_id: int) -> None:
                async with SessionFactory() as s:
                    s.add_all(
                        [
                            Message(session_id=sess_id, role="user", content="ещё вопрос"),
                            Message(session_id=sess_id, role="assistant", content="ещё ответ"),
                        ]
                    )
                    await s.commit()

            with client._portal_factory() as portal:
                portal.call(go, sess_a)

            r = client.get(f"/sessions/{sess_a}/messages", params={"limit": 2})
            assert r.status_code == 200, r.text
            msgs = r.json()["messages"]
            assert len(msgs) == 2
            assert msgs[0]["content"] == "ещё вопрос"
            assert msgs[1]["content"] == "ещё ответ"
        finally:
            _cleanup(client, user_pk)
