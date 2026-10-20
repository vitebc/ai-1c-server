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


#: Признак служебного чанка статьи — её заголовка с номером версии. Нужен,
#: чтобы запрос «что нового в версии X» находил нужный релиз: номер версии
#: есть только в заголовке. Содержания он не несёт, поэтому при выдаче
#: разворачивается в содержательные чанки той же статьи (см. retrieve).
#:
#: Признак — ровно текст заголовка документа (documents.title): обычные
#: документы такого чанка не имеют, поэтому разворачивание не срабатывает
#: на пересечении с содержимым.
HEADER_CHUNK_POSITION = 0

#: Сколько содержательных чанков статьи подставлять вместо её заголовка.
HEADER_EXPANSION = 3


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
        select(
            Document.title,
            Chunk.text,
            Chunk.position,
            Chunk.document_id,
            distance.label("distance"),
        )
        .join(Chunk, Chunk.document_id == Document.id)
        .order_by(distance)
        .limit(top_k * 3)
    )
    if access_profile != "all":
        stmt = stmt.where(or_(Document.access_profile == "all", Document.access_profile == access_profile))
    if agent_name:
        # RAG-изоляция по агенту: общий документ (NULL) виден всем агентам.
        stmt = stmt.where(or_(Document.agent_name.is_(None), Document.agent_name == agent_name))
    async with session_factory() as session:
        rows = (await session.execute(stmt)).all()
        # Содержательные чанки статей, чей заголовок попал в выдачу: ими
        # заменяем сам заголовок (он не несёт содержания).
        header_docs = {doc_id for t, x, _pos, doc_id, _d in rows if x == t}
        expanded: list[tuple[str, str, float]] = []
        if header_docs:
            body_stmt = (
                select(Document.title, Chunk.text, Chunk.position, Chunk.document_id, distance.label("distance"))
                .join(Chunk, Chunk.document_id == Document.id)
                .where(
                    Chunk.document_id.in_(header_docs),
                    Chunk.text != Document.title,
                )
                .order_by(distance)
                .limit(HEADER_EXPANSION * len(header_docs))
            )
            expanded = [(t, x, float(d)) for t, x, _p, _doc, d in (await session.execute(body_stmt)).all()]

    # Отсечка по релевантности: у реальной модели косинус «просто русского
    # текста» ~0.4-0.6, поэтому без порога агент получал бы «мусор» вместо
    # честного «в базе знаний ничего не нашлось». cosine_distance = 1 - cos.
    out: list[dict[str, str]] = []
    seen_texts: set[str] = set()
    # Разворачиваем заголовок только ЛУЧШЕГО совпадения: иначе в выдачу
    # попадают содержательные чанки всех версий-«соседей» (они тоже похожи
    # по номеру версии) и место содержания нужной статьи съедается.
    header_expanded = False
    for title, text, _pos, _doc_id, dist in rows:
        if text == title:
            if header_expanded:
                continue
            header_expanded = True
            # Заголовок: вместо него — содержательные чанки этой статьи.
            for e_title, e_text, _e_dist in expanded:
                if e_title != title or e_text in seen_texts:
                    continue
                # Порог здесь не применяем: заголовок статьи уже совпал с
                # запросом (номер версии) — это и есть доказательство
                # релевантности. Содержательные чанки короче и косинус у них
                # ниже (0.30-0.47 против 0.64 у заголовка), отсечка бы их
                # выкинула вместе с содержимым статьи.
                out.append({"title": e_title, "text": e_text})
                seen_texts.add(e_text)
            continue
        if len(out) >= top_k:
            break
        if min_score > 0 and (1.0 - float(dist)) < min_score:
            continue
        if text in seen_texts:
            continue
        out.append({"title": title, "text": text})
        seen_texts.add(text)
    return out[:top_k]


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
