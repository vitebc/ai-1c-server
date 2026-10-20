"""Поиск по базе знаний: embed -> cosine в pgvector -> фильтр прав.

Фильтр (см. AGENTS.md, «Схема запросов»): документ с access_profile='all'
виден всем; остальные — только пользователям с тем же профилем; профиль
пользователя 'all' (админ) видит всё. Фильтрация — WHERE-клаузой на этапе
retrieval, а не постобработкой.
"""

from __future__ import annotations

import json

from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.tools import ToolContext, ToolDefinition
from app.db.models import Chunk, Document
from app.rag.embeddings import Embeddings

#: Instruct-префикс для запросов retrieval. Описывает ЗАДАЧУ поиска: модель
#: обучена на таком формате (асимметричный retrieval — запрос с инструкцией,
#: документ без).
#:
#: Формулировка НЕЙТРАЛЬНАЯ про домен — намеренно. Вариант, называющий домен
#: («...from 1C:Enterprise release notes»), подтягивает к любому запросу
#: вектор в сторону корпуса: «мусорные» запросы поднимаются с 0.39 до 0.55
#: и порог отсечки перестаёт работать. Замеры по корпусу из 300 статей:
#:
#:              top1   top5   top10   «мусор» (макс.)
#:   без префикса   81    100     109         0.39
#:   нейтральный    82    104     113         0.50
#:   с доменом      77    104     109         0.55
QUERY_INSTRUCTION = "Instruct: Given a user question in Russian, retrieve relevant passages\nQuery: "


class KbSearchArgs(BaseModel):
    query: str = Field(min_length=2)
    top_k: int = Field(default=5, le=10)


async def retrieve(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    embeddings: Embeddings,
    query: str,
    access_profile: str,
    top_k: int = 5,
    agent_name: str = "",
    min_score: float = 0.0,
) -> list[dict[str, str]]:
    # Запрос эмбеддится асимметрично (с instruct-префиксом), документы — как есть.
    vector = await embeddings.embed_query(query, QUERY_INSTRUCTION)
    distance = Chunk.embedding.cosine_distance(vector)
    stmt = (
        select(Document.title, Chunk.text, distance.label("distance"))
        .join(Chunk, Chunk.document_id == Document.id)
        .order_by(distance)
        .limit(top_k)
    )
    if access_profile != "all":
        stmt = stmt.where(or_(Document.access_profile == "all", Document.access_profile == access_profile))
    if agent_name:
        # RAG-изоляция по агенту: общий документ (NULL) виден всем агентам.
        stmt = stmt.where(or_(Document.agent_name.is_(None), Document.agent_name == agent_name))
    async with session_factory() as session:
        rows = (await session.execute(stmt)).all()
    # Отсечка по релевантности: у реальной модели косинус «просто русского
    # текста» ~0.4-0.6, поэтому без порога агент получал бы «мусор» вместо
    # честного «в базе знаний ничего не нашлось». cosine_distance = 1 - cos.
    return [
        {"title": title, "text": text}
        for title, text, dist in rows
        if min_score <= 0 or (1.0 - float(dist)) >= min_score
    ]


def make_kb_search(
    session_factory: async_sessionmaker[AsyncSession],
    embeddings: Embeddings,
    min_score: float = 0.0,
) -> ToolDefinition:
    async def handler(args: KbSearchArgs, ctx: ToolContext) -> str:
        rows = await retrieve(
            session_factory=session_factory,
            embeddings=embeddings,
            query=args.query,
            access_profile=ctx.access_profile,
            top_k=args.top_k,
            agent_name=ctx.agent_name,
            min_score=min_score,
        )
        if not rows:
            return json.dumps(
                {"found": False, "hint": "В базе знаний ничего не нашлось. Ответь без неё."},
                ensure_ascii=False,
            )
        return json.dumps({"found": True, "fragments": rows}, ensure_ascii=False)

    return ToolDefinition(
        name="search_knowledge_base",
        description="Поиск по базе знаний 1С: что нового в версиях (релизы 1С:Enterprise, "
        "в т.ч. 1С:Комплексная автоматизация), регламенты, инструкции, порядок настройки. "
        "Используй для вопросов про новые возможности и изменения в конкретных версиях, "
        "а также про правила, сроки и процедуры.",
        args_model=KbSearchArgs,
        handler=handler,
        server="local",
    )
