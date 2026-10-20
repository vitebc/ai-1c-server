"""Тесты чистки корпуса (app/rag/corpus.py).

Чистка убирает служебный мусор выгрузки its.1c.ru: заголовок страницы,
оглавление статьи и битые ссылки на картинки. Всё это повторяется в сотнях
статей и тянет в выдачу поиска любые запросы.

Тот же код использует CLI-инжест и HTTP-API /rag/* — тест на общий модуль.
"""

from __future__ import annotations

from app.rag.corpus import build_chunks, clean_markdown, is_metadata_only

PAGE = (
    "1С:Комплексная автоматизация 2. Новое в версии 2.6.1.64 :: "
    "Информация об обновлениях программных продуктов 1С:Предприятие\n"
    "\n"
    "\n"
    "# 1С:Комплексная автоматизация 2. Новое в версии 2.6.1.64\n"
    "\n"
    "Дата выхода релиза: 17.09.2026\n"
    "\n"
    "* [Казначейство](#issogl1_1)\n"
    "  + [Загрузка выписки по счету цифрового рубля](#issogl2_2)\n"
    "\n"
    "## Казначейство\n"
    "\n"
    "Счет 53 добавлен в план счетов.\n"
    "\n"
    "![](image001.png?_=0001FF962B833294-v10)\n"
)

TITLE = "1С:Комплексная автоматизация 2. Новое в версии 2.6.1.64"


def test_page_title_removed() -> None:
    out = clean_markdown(PAGE)
    assert "Информация об обновлениях" not in out
    assert "Дата выхода релиза" in out
    assert "# 1С:Комплексная автоматизация 2. Новое в версии 2.6.1.64" in out


def test_toc_removed() -> None:
    out = clean_markdown(PAGE)
    assert "[Казначейство](#issogl1_1)" not in out
    assert "Загрузка выписки" not in out
    # Содержание раздела осталось.
    assert "Счет 53 добавлен в план счетов." in out
    assert "## Казначейство" in out


def test_images_removed() -> None:
    out = clean_markdown(PAGE)
    assert "image001.png" not in out
    assert "![" not in out


def test_content_untouched() -> None:
    """Обычный markdown без артефактов выгрузки не меняется (кроме хвоста)."""
    text = "# Заголовок\n\nТекст абзаца.\n\n## Раздел\n\nЕщё текст.\n"
    assert clean_markdown(text) == text.rstrip()


def test_blank_runs_collapsed() -> None:
    out = clean_markdown("A\n\n\n\n\nB\n")
    assert out == "A\n\nB"


def test_metadata_only_chunk_detected() -> None:
    """Чанк из заголовка и даты выхода релиза — метаданные, а не содержание."""
    metadata = f"{TITLE}\n\nДата выхода релиза: 17.09.2026"
    assert is_metadata_only(metadata, TITLE)
    # С содержанием — не метаданные.
    assert not is_metadata_only(metadata + "\n\nСчет 53 добавлен в план счетов.", TITLE)


def test_content_chunk_not_metadata_only() -> None:
    assert not is_metadata_only("## Казначейство\n\nСчет 53 добавлен в план счетов.", TITLE)


def test_build_chunks_header_first() -> None:
    """Первым идёт служебный чанк-заголовок (с номером версии)."""
    text = clean_markdown(PAGE)
    chunks = build_chunks(text, TITLE)
    assert chunks[0] == TITLE
    # Заголовок не дублируется в остальных чанках (иначе выдача размывается).
    assert all(TITLE not in c for c in chunks[1:])
    # Содержание на месте.
    assert any("Счет 53 добавлен в план счетов." in c for c in chunks)


def test_build_chunks_drops_metadata_only() -> None:
    """Чанк из одних метаданных релиза отбрасывается."""
    metadata_only = f"{TITLE}\n\nДата выхода релиза: 17.09.2026"
    chunks = build_chunks(metadata_only, TITLE)
    # Остался только служебный заголовок.
    assert chunks == [TITLE]
