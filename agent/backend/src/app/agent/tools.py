"""Инструменты агента: описание + pydantic-схема аргументов + обработчик.

Схема для модели генерируется из args_model (model_json_schema) — один источник
правды для описания и валидации. Обработчик принимает уже провалидированную
модель; Any в сигнатуре — осознанно (конкретные обработчики сужают тип).
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel


def clean_parameters(schema: dict[str, Any] | None) -> dict[str, Any]:
    """JSON Schema без `$`-ключей и `title` — для границы «JSON → BSL / Структура 1С».

    Форма 1С читает схемы тулзов через `ПрочитатьJSON` в `Структура`, а ключи с `$`
    (`$schema`, `$defs`, …) для неё недопустимы («Недопустимое имя свойства»).
    Применяется ТОЛЬКО там, где схемы уходят наружу (REST-инвентарь `GET /tools`,
    тулза `list_registry`) — не в LLM-схемы (`openai_schema`), где `$defs`/`$ref`
    легальны. Правила зеркалят Rust `src/mcp/clean.rs`:

    - удаляются ключи, начинающиеся с `$` (любой глубины);
    - `title` — убирается;
    - при удалении `$defs`/`definitions` ссылки `$ref: "#/$defs/X"` разворачиваются
      в сами определения (защита от циклов — ссылка просто пропадает).
    """
    if schema is None:
        return {"type": "object", "properties": {}}

    def resolve_ref(v: Any, defs: dict[str, Any], in_progress: set[str]) -> dict[str, Any] | None:
        path = v if isinstance(v, str) else ""
        rest = path.removeprefix("#/$defs/").removeprefix("#/definitions/")
        if not path.startswith(("#/$defs/", "#/definitions/")) or rest == path:
            return None
        current: Any = defs
        for part in rest.split("/"):
            if not isinstance(current, dict) or part not in current:
                return None
            current = current[part]
        if not isinstance(current, dict):
            return None
        return _clean_obj(current, 0, defs, in_progress)

    def _clean_obj(m: dict[str, Any], depth: int, defs: dict[str, Any], in_progress: set[str]) -> dict[str, Any]:
        if depth >= 32:
            return {k: v for k, v in m.items() if not str(k).startswith("$") and k != "title"}
        local_defs = m.get("$defs") or m.get("definitions")
        if not isinstance(local_defs, dict):
            local_defs = defs
        out: dict[str, Any] = {}
        for k, v in m.items():
            if k == "$ref":
                ref_path = v if isinstance(v, str) else ""
                if ref_path not in in_progress:
                    child_in_progress = in_progress | {ref_path}
                    resolved = resolve_ref(ref_path, local_defs, child_in_progress)
                    if resolved is not None:
                        for rk, rv in resolved.items():
                            out.setdefault(rk, rv)
                continue
            if str(k).startswith("$") or k == "title":
                continue
            if isinstance(v, (dict, list)):
                out[k] = _clean_value(v, depth + 1, local_defs, in_progress)
            else:
                out[k] = v
        return out

    def _clean_value(v: Any, depth: int, defs: dict[str, Any], in_progress: set[str]) -> Any:
        if isinstance(v, dict):
            return _clean_obj(v, depth, defs, in_progress)
        if isinstance(v, list):
            return [_clean_value(it, depth + 1, defs, in_progress) for it in v]
        return v

    return _clean_obj(schema, 0, {}, set())


@dataclass(frozen=True)
class ToolContext:
    user_id: str  # идентификатор пользователя 1С из токена сессии
    # Профиль прав для фильтрации retrieval (см. AGENTS.md, «Схема запросов»).
    # Резолвится вызывающей стороной (чат-эндпоинт — из таблицы users).
    access_profile: str = "all"
    # Имя ИБ 1С (НРег): для будущей маршрутизации по базам.
    base_name: str = ""
    # Рантайм-агент (backend/agents/<name>): для RAG-изоляции retrieval.
    agent_name: str = ""
    # Корень публикации базы (http://host/base) — для тулз, ходящих в 1С сами.
    # Пусто — штатный путь mock/прокси.
    base_url: str = ""


ToolHandler = Callable[[Any, ToolContext], Coroutine[Any, Any, str]]


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    args_model: type[BaseModel]
    handler: ToolHandler
    # Для динамических MCP-тулзов (см. app.onec.live:make_generic_tool) — прямой
    # JSON Schema из прокси. Если задан, уходит модели вместо model_json_schema().
    parameters_schema: dict[str, Any] | None = None
    # Источник инструмента: "default" (прокси 1С), "local" (БЗ/паттерны — вне
    # отбора по mcp, доступны всегда) или имя подсервера агрегатора
    # (напр. "search-ka-update"). Агент фильтруется по Agent.mcp_servers.
    server: str = "default"

    @property
    def openai_schema(self) -> dict[str, Any]:
        params = self.parameters_schema if self.parameters_schema is not None else self.args_model.model_json_schema()
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": params,
            },
        }


class ToolRegistry:
    def __init__(self, tools: list[ToolDefinition]) -> None:
        self._tools = {t.name: t for t in tools}

    def schemas(self) -> list[dict[str, Any]]:
        return [t.openai_schema for t in self._tools.values()]

    def get(self, name: str) -> ToolDefinition | None:
        return self._tools.get(name)

    def subset(self, names: list[str] | tuple[str, ...]) -> ToolRegistry:
        """Новый реестр только с перечисленными инструментами (порядок — как в списке).

        Неизвестные имена тихо отбрасываются — вызыватель логирует их сам.
        """
        wanted = list(names)
        return ToolRegistry([self._tools[n] for n in wanted if n in self._tools])

    @property
    def names(self) -> list[str]:
        return sorted(self._tools)

    @property
    def tools(self) -> list[ToolDefinition]:
        return list(self._tools.values())
