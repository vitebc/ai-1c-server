"""Тесты мапы search-серверов: форматы v1/v2, парсинг, hot-reload, фильтрация реестра."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import BaseModel

from app.agent import ToolRegistry
from app.agent.tools import ToolDefinition
from app.agents import Agent
from app.api.chat import scope_registry_for_agent
from app.onec import search_maps
from app.tools import MOCK_ONEC_TOOLS

V2 = "# search-maps v2: сервер=база1,база2. '*' — дефолт для неупомянутых баз."


def _agent_with_search_tools() -> Agent:
    """Агент с тулзами трёх search-серверов + одной локальной."""
    return Agent(
        name="test-search",
        title="Тест",
        description="тест",
        tools=(
            "search-ka-update__semantic_find",
            "search-ka-rs__semantic_find",
            "search-ka-td__semantic_find",
            "get_counterparty",
        ),
        skills=(),
        mcp_servers=("default", "search-ka-update", "search-ka-rs", "search-ka-td"),
        model="",
        max_rounds=None,
        prompt="Промпт.",
        source="/tmp/test-search/AGENT.md",
    )


class _EmptyArgs(BaseModel):
    pass


def _registry_with_search_tools() -> ToolRegistry:
    """Реестр: mock-тулзы + фиктивные search-тулзы (в MOCK_ONEC_TOOLS их нет)."""

    async def _handler(args, ctx) -> str:
        return "{}"

    tools = list(MOCK_ONEC_TOOLS)
    for srv in ("search-ka-update", "search-ka-rs", "search-ka-td"):
        tools.append(
            ToolDefinition(
                name=f"{srv}__semantic_find",
                description=f"тестовая тулза {srv}",
                args_model=_EmptyArgs,
                handler=_handler,
                server=srv,
            )
        )
    return ToolRegistry(tools)


def _load(raw: str, tmp_path: Path, monkeypatch) -> None:
    """Записать файл мапы и сбросить кэш (как при hot-reload)."""
    p = tmp_path / "search-maps.conf"
    p.write_text(raw, encoding="utf-8")
    monkeypatch.setenv("SEARCH_MAPS_FILE", str(p))
    search_maps._state.maps = None


# ---------- формат v1 (legacy, без маркера) ----------


def test_is_v2_marker() -> None:
    assert not search_maps.is_v2("doc=search-ka-update")
    assert search_maps.is_v2(V2 + "\n;\nsearch-ka-td=doc;")
    # Маркер ищется в сыром тексте: v1-файл со словом «v2» в комментарии — не v2.
    assert not search_maps.is_v2("# комментарий без маркера\ndoc=")


def test_parse_v1_inverts_to_canon() -> None:
    """v1 'база=серверы' инвертируется в памяти в серверные строки; 'база=' — блок."""
    maps = search_maps.parse_search_maps("doc=search-ka-update,search-ka-rs;ca2_td=search-ka-td;ai_base=")
    assert maps.servers == {
        "search-ka-update": ["doc"],
        "search-ka-rs": ["doc"],
        "search-ka-td": ["ca2_td"],
    }
    assert maps.wildcard is None
    assert maps.blocked == {"ai_base"}


def test_parse_v1_bad() -> None:
    for bad in ("no-equals", "=servers"):
        with pytest.raises(ValueError):
            search_maps.parse_v1(bad)


def test_parse_v1_unknown_base_fail_open(tmp_path: Path, monkeypatch) -> None:
    _load("doc=search-ka-update", tmp_path, monkeypatch)
    # База не в мапе — без фильтрации.
    assert search_maps.allowed_search_servers("other-base") is None


def test_v1_allowed_servers_mapped_base(tmp_path: Path, monkeypatch) -> None:
    _load("doc=search-ka-update,search-ka-rs;ca2_td=search-ka-td", tmp_path, monkeypatch)
    assert search_maps.allowed_search_servers("DOC") == ["search-ka-update", "search-ka-rs"]
    assert search_maps.allowed_search_servers("ca2_td") == ["search-ka-td"]


def test_v1_empty_list_means_no_search(tmp_path: Path, monkeypatch) -> None:
    """Запись 'база=' — база в мапе, но серверов нет: кодовые тулзы не выдаются."""
    _load("ai_base=", tmp_path, monkeypatch)
    assert search_maps.allowed_search_servers("ai_base") == []


# ---------- формат v2 ----------


def test_parse_v2_basic() -> None:
    maps = search_maps.parse_v2(V2 + "\n;\n;\nsearch-ka-td=doc,ca2_td;\nsearch-ka-rs=doc;")
    assert maps.servers == {"search-ka-td": ["doc", "ca2_td"], "search-ka-rs": ["doc"]}
    assert maps.wildcard is None
    assert maps.blocked == set()


def test_parse_v2_lowercase_and_last_wins() -> None:
    maps = search_maps.parse_v2(V2 + ";\nSEARCH-KA-TD=Doc;\nsearch-ka-td=ca2_td;")
    assert maps.servers == {"search-ka-td": ["ca2_td"]}
    assert maps.allowed("CA2_TD") == ["search-ka-td"]  # базы в значениях — НРег
    assert maps.allowed("DOC") is None


def test_parse_v2_wildcard() -> None:
    maps = search_maps.parse_v2(V2 + ";\nsearch-ka-td=doc;\n*=search-ka-update;")
    assert maps.wildcard == ["search-ka-update"]
    assert maps.allowed("other-base") == ["search-ka-update"]
    assert maps.allowed("doc") == ["search-ka-td"]


def test_parse_v2_wildcard_empty_means_block() -> None:
    maps = search_maps.parse_v2(V2 + ";\nsearch-ka-td=doc;\n*=;")
    assert maps.wildcard == []
    assert maps.allowed("ca2_td") == []
    assert maps.allowed("doc") == ["search-ka-td"]


def test_parse_v2_block_rows() -> None:
    maps = search_maps.parse_v2(V2 + ";\n!ai_base=;\n!doc3=;")
    assert maps.blocked == {"ai_base", "doc3"}


def test_parse_v2_block_priority_over_mention() -> None:
    maps = search_maps.parse_v2(V2 + ";\nsearch-ka-update=doc;\n!doc=;")
    assert maps.allowed("doc") == []  # блок сильнее упоминания


def test_parse_v2_bad() -> None:
    for bad in (
        V2 + ";\n!=doc;",  # блок-строке нельзя назначить серверы
        V2 + ";\n!;=;",  # пустое имя базы в блок-строке
        V2 + ";\nсеarch=doc;",  # не-ascii ключ сервера
        V2 + ";\n=servers;",  # пустой ключ
    ):
        with pytest.raises(ValueError):
            search_maps.parse_v2(bad)


def test_v2_allowed_servers_no_base() -> None:
    assert search_maps.allowed_search_servers(None) is None
    assert search_maps.allowed_search_servers("") is None


def test_v2_wildcard_semantics_via_file(tmp_path: Path, monkeypatch) -> None:
    raw = V2 + ";\n;\nsearch-ka-td=ca2_td,doc;\n*=search-ka-update;"
    _load(raw, tmp_path, monkeypatch)
    assert search_maps.allowed_search_servers("ca2_TD") == ["search-ka-td"]
    assert search_maps.allowed_search_servers("doc") == ["search-ka-td"]
    assert search_maps.allowed_search_servers("mirror-x") == ["search-ka-update"]


def test_v2_no_wildcard_unmentioned_fail_open(tmp_path: Path, monkeypatch) -> None:
    raw = V2 + ";\n;\nsearch-ka-td=ca2_td;"
    _load(raw, tmp_path, monkeypatch)
    assert search_maps.allowed_search_servers("unknown-base") is None


# ---------- hot-reload ----------


def test_hot_reload_on_mtime_change(tmp_path: Path, monkeypatch) -> None:
    _load("ca2_td=search-ka-td", tmp_path, monkeypatch)
    assert search_maps.allowed_search_servers("ca2_td") == ["search-ka-td"]
    p = tmp_path / "search-maps.conf"
    p.write_text("doc=search-ka-update", encoding="utf-8")
    # mtime совпадёт по целым секундам — ускоряем TTL-проверку, как делает hot-reload.
    search_maps._state.at = 0.0
    assert search_maps.allowed_search_servers("DOC") == ["search-ka-update"]
    assert search_maps.allowed_search_servers("ca2_td") is None


def test_no_map_file(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SEARCH_MAPS_FILE", str(tmp_path / "absent.conf"))
    search_maps._state.maps = None
    assert search_maps.allowed_search_servers("any-base") is None


# ---------- фильтрация реестра ----------


def test_scope_filters_by_v1_map(tmp_path: Path, monkeypatch) -> None:
    _load("ca2_td=search-ka-td", tmp_path, monkeypatch)

    reg = _registry_with_search_tools()
    agent = _agent_with_search_tools()

    # База в мапе: только её сервер.
    scoped, rejected = scope_registry_for_agent(reg, agent, base_name="ca2_td")
    names = set(scoped.names)
    assert "search-ka-td__semantic_find" in names
    assert "search-ka-update__semantic_find" not in names
    assert "search-ka-rs__semantic_find" not in names
    assert "get_counterparty" in names  # не-search — не тронут
    assert any("search-ka-update" in r for r in rejected)

    # База вне мапы: все search-серверы агента.
    scoped2, _ = scope_registry_for_agent(reg, agent, base_name="other-base")
    assert "search-ka-update__semantic_find" in set(scoped2.names)
    assert "search-ka-rs__semantic_find" in set(scoped2.names)

    # Без базы: без фильтрации.
    scoped3, _ = scope_registry_for_agent(reg, agent)
    assert "search-ka-td__semantic_find" in set(scoped3.names)


def test_scope_filters_by_v2_map_with_wildcard(tmp_path: Path, monkeypatch) -> None:
    raw = V2 + ";\n;\nsearch-ka-td=ca2_td;\n*=search-ka-rs;"
    _load(raw, tmp_path, monkeypatch)

    reg = _registry_with_search_tools()
    agent = _agent_with_search_tools()

    # Неупомянутая база получает серверы из '*'.
    scoped, _ = scope_registry_for_agent(reg, agent, base_name="mirror-user")
    names = set(scoped.names)
    assert "search-ka-rs__semantic_find" in names
    assert "search-ka-td__semantic_find" not in names

    # В блоке '*=' — неупомянутые базы теряют все search-тулзы.
    _load(V2 + ";\n;\nsearch-ka-td=ca2_td;\n*=;", tmp_path, monkeypatch)
    scoped2, rejected2 = scope_registry_for_agent(reg, agent, base_name="mirror-user")
    assert "search-ka-td__semantic_find" not in set(scoped2.names)
    assert "search-ka-rs__semantic_find" not in set(scoped2.names)
    assert len(rejected2) == 3


def test_scope_no_map_file(tmp_path: Path, monkeypatch) -> None:
    """Файла мапы нет — фильтрации нет вообще."""
    monkeypatch.setenv("SEARCH_MAPS_FILE", str(tmp_path / "absent.conf"))
    search_maps._state.maps = None

    reg = _registry_with_search_tools()
    agent = _agent_with_search_tools()
    scoped, rejected = scope_registry_for_agent(reg, agent, base_name="any-base")
    assert len(rejected) == 0
    assert "search-ka-update__semantic_find" in set(scoped.names)
