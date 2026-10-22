"""Мапа search-серверов: какие кодовые индексы видит агент для конкретной базы.

Формат v2 (маркер «# search-maps v2» в заголовке): строка «сервер=база1,база2».
Спец-ключи: '*' — дефолт для баз, не упомянутых ни в одной строке; '!база' —
явный запрет (кодовые тулзы базе не выдаются вовсе). Канонический ответ
allowed_search_servers(base):
  - база в блок-строке -> [] (приоритет выше упоминаний);
  - база упомянута в >=1 строке сервера -> только эти серверы;
  - не упомянута, есть '*' -> список из '*' (пустая '*' = блок для прочих);
  - не упомянута, '*' нет -> None: без фильтрации (видит всё из AGENT.md агента).

Файл старого формата (v1, «база=серверы») без маркера читается как есть и
инвертируется в памяти: поведение прежнее. В момент первой записи из админки
файл переписывается в v2. Комментарии (#) и пустые чанки пропускаются,
кривые записи -> ValueError (весь файл отбрасывается, hot-reload держит
предыдущее значение).

Путь: SEARCH_MAPS_FILE (по умолчанию backend/search-maps.conf),
hot-reload по mtime, TTL 2с.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field

log = logging.getLogger("agent1c.search_maps")

V2_MARKER = "# search-maps v2"


def _default_search_maps_file() -> str:
    # src/app/onec/search_maps.py -> backend/search-maps.conf (тот же путь, что bases.conf).
    return os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "search-maps.conf")
    )


def search_maps_file() -> str:
    """Путь к файлу мапы (SEARCH_MAPS_FILE). Пусто — дефолтный backend/search-maps.conf."""
    return os.environ.get("SEARCH_MAPS_FILE", "").strip() or _default_search_maps_file()


def is_v2(raw: str) -> bool:
    """Формат по маркеру в заголовке: v1 без маркера, v2 с маркером."""
    return V2_MARKER in raw


@dataclass
class SearchMaps:
    """Канонический вид мапы (v2-семантика) при любом формате файла."""

    servers: dict[str, list[str]] = field(default_factory=dict)  # сервер -> базы
    wildcard: list[str] | None = None  # строка '*'
    blocked: set[str] = field(default_factory=set)  # строки '!база'

    def allowed(self, base_name: str | None) -> list[str] | None:
        if not base_name:
            return None
        key = base_name.strip().lower()
        if key in self.blocked:
            return []
        hits = [srv for srv, bases in self.servers.items() if key in bases]
        if hits:
            return hits
        if self.wildcard is not None:
            return list(self.wildcard)
        return None


def _name_ok(name: str) -> bool:
    return bool(name) and all(c.isalnum() and c.isascii() or c in "_-" for c in name)


def parse_v2(raw: str) -> SearchMaps:
    """Разобрать v2: 'сервер=база1,база2;*=...;!база=' -> SearchMaps.

    Ключи — НРег (кроме '*'). Строка '!' с непустым значением — ошибка
    (блок-строке нельзя назначить серверы). Последняя строка с тем же
    ключом побеждает. 'сервер=' (пустой список) — валидно: сервер на
    текущий момент никому не выдаётся.
    """
    out = SearchMaps()
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk or chunk.startswith("#"):
            continue
        key, _, value = chunk.partition("=")
        key = key.strip()
        if not key:
            raise ValueError(f"пустой ключ: {chunk!r}")
        bases = [b.strip().lower() for b in value.split(",") if b.strip()]
        if key == "*":
            out.wildcard = bases
            continue
        if key.startswith("!"):
            base = key[1:].strip().lower()
            if bases:
                raise ValueError(f"блок-строке нельзя назначить серверы: {chunk!r}")
            if not base or not _name_ok(base):
                raise ValueError(f"пустое имя базы в блок-строке: {chunk!r}")
            out.blocked.add(base)
            continue
        key = key.lower()
        if not _name_ok(key):
            raise ValueError(f"некорректный ключ сервера: {chunk!r}")
        # Канон v2-строк: последняя строка с этим ключом побеждает.
        out.servers[key] = bases
    return out


def parse_v1(raw: str) -> dict[str, list[str]]:
    """Разобрать v1 ('база=сервер1,сервер2') — прежний формат.

    Запись 'база=' (пустой список) не ошибка: база в мапе, но кодовых тулзов
    ей не выдаётся вовсе. Кривая запись — ValueError (весь файл отбрасывается).
    """
    out: dict[str, list[str]] = {}
    for chunk in raw.split(";"):
        chunk = chunk.strip()
        if not chunk or chunk.startswith("#"):
            continue
        if "=" not in chunk:
            raise ValueError(f"запись без '=': {chunk!r}")
        name, _, servers = chunk.partition("=")
        name = name.strip().lower()
        if not name:
            raise ValueError(f"пустое имя базы: {chunk!r}")
        server_list = [s.strip() for s in servers.split(",") if s.strip()]
        out[name] = server_list
    return out


def from_v1(v1: dict[str, list[str]]) -> SearchMaps:
    """Инвертировать v1 в канон v2 в памяти (поведение прежнее)."""
    out = SearchMaps()
    for base, srvs in v1.items():
        if srvs:
            for srv in srvs:
                out.servers.setdefault(srv, []).append(base)
        else:
            out.blocked.add(base)
    return out


def parse_search_maps(raw: str) -> SearchMaps:
    """Разобрать файл любого формата: v2 по маркеру, иначе v1 (инверсия в памяти)."""
    if is_v2(raw):
        return parse_v2(raw)
    return from_v1(parse_v1(raw))


@dataclass
class _State:
    mtime: float = -1.0
    at: float = 0.0
    maps: SearchMaps | None = None


_state = _State()
_TTL_S = 2.0


def get_search_maps() -> SearchMaps:
    """Текущая мапа (hot-reload по mtime, TTL 2с). Файла нет — пустая (без фильтрации)."""
    path = search_maps_file()
    now = time.monotonic()
    # maps is None (холодный старт или явный сброс) — читаем сразу, не ждём TTL.
    if path and (_state.maps is None or now - _state.at >= _TTL_S):
        _state.at = now
        st = None
        try:
            st = os.stat(path)
        except OSError:
            pass
        if st is not None:
            mtime = st.st_mtime
            if mtime != _state.mtime or _state.maps is None:
                try:
                    with open(path, encoding="utf-8") as f:
                        raw = f.read()
                    _state.maps = parse_search_maps(raw)
                    _state.mtime = mtime
                    fmt = "v2" if is_v2(raw) else "v1"
                    log.info(
                        "мапа search-серверов (%s) перечитана из %s: %d сервер(ов)",
                        fmt,
                        path,
                        len(_state.maps.servers),
                    )
                except (OSError, ValueError) as e:
                    log.warning("не удалось перечитать мапу search-серверов из %s: %s", path, e)
    return _state.maps or SearchMaps()


def allowed_search_servers(base_name: str | None) -> list[str] | None:
    """Разрешённые search-серверы для базы.

    None — фильтрация не нужна (база нигде не упомянута и нет '*'):
    все серверы, разрешённые агентом в AGENT.md. Пустой список — тузы
    базе не выдаются вовсе (блок-строка или пустая '*').
    """
    return get_search_maps().allowed(base_name)
