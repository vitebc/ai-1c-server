"""Тесты clean_parameters: чистка JSON Schema на границе «JSON → BSL / 1С».

Зеркалит правила Rust src/mcp/clean.rs: $-ключи и title убираются, $ref
разворачивается в определение из $defs/definitions, циклы не роняют.
"""

from __future__ import annotations

from typing import Any

from app.agent.tools import clean_parameters


def _no_dollar_keys(v: Any) -> list[str]:
    """Рекурсивно собрать все ключи с $ и title (должно быть пусто)."""
    found: list[str] = []
    if isinstance(v, dict):
        for k, val in v.items():
            if str(k).startswith("$") or k == "title":
                found.append(str(k))
            found.extend(_no_dollar_keys(val))
    elif isinstance(v, list):
        for it in v:
            found.extend(_no_dollar_keys(it))
    return found


def test_strips_dollar_keys_and_title() -> None:
    schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "title": "Запрос",
        "description": "поиск",
        "properties": {
            "query": {"type": "string", "title": "Запрос"},
            "nested": {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "properties": {"x": {"type": "integer"}},
            },
        },
        "required": ["query"],
    }
    out = clean_parameters(schema)
    assert _no_dollar_keys(out) == []
    assert out["type"] == "object"
    assert out["description"] == "поиск"
    assert out["properties"]["query"]["type"] == "string"
    assert out["properties"]["nested"]["properties"]["x"]["type"] == "integer"
    assert out["required"] == ["query"]


def test_resolves_defs_refs() -> None:
    schema = {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {"item": {"$ref": "#/$defs/Item"}},
        "$defs": {
            "Item": {
                "type": "object",
                "title": "Позиция",
                "properties": {"name": {"type": "string"}},
            }
        },
    }
    out = clean_parameters(schema)
    assert _no_dollar_keys(out) == []
    item = out["properties"]["item"]
    assert item["type"] == "object"
    assert item["properties"]["name"]["type"] == "string"


def test_handles_cyclic_refs() -> None:
    schema = {
        "type": "object",
        "properties": {"node": {"$ref": "#/$defs/Node"}},
        "$defs": {
            "Node": {
                "type": "object",
                "properties": {
                    "value": {"type": "string"},
                    "next": {"$ref": "#/$defs/Node"},
                },
            }
        },
    }
    out = clean_parameters(schema)  # не зацикливается и не падает
    assert _no_dollar_keys(out) == []
    node = out["properties"]["node"]
    assert node["type"] == "object"
    assert node["properties"]["value"]["type"] == "string"


def test_none_becomes_empty_object() -> None:
    assert clean_parameters(None) == {"type": "object", "properties": {}}


def test_passthrough_plain_schema() -> None:
    schema = {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}
    out = clean_parameters(schema)
    assert out == schema
