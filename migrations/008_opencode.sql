-- 008_opencode.sql
-- Шлюз OpenCode: серверы (по одному на базу 1С), маршрутизация по claim `base`
-- JWT пользователя 1С, прокси API/SSE и RLS-мост инструментов 1С.

CREATE TABLE IF NOT EXISTS opencode_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,          -- имя из claim `base` JWT 1С / ?base= / X-1C-Base
    title TEXT NOT NULL DEFAULT '',     -- человекочитаемое имя в UI
    config_dir TEXT NOT NULL,           -- абсолютный путь к config/<server> (конфиг/агенты/скилы/плагин)
    url TEXT NOT NULL,                  -- адрес OpenCode API, напр. http://127.0.0.1:4040
    username TEXT NOT NULL DEFAULT 'opencode',  -- Basic auth OpenCode
    password TEXT NOT NULL DEFAULT '',
    bases TEXT NOT NULL DEFAULT '',     -- JSON-массив имён баз 1С (для UI, справочно)
    compose_service TEXT NOT NULL DEFAULT '',   -- сервис в docker-compose 1C-opencode (пусто = без compose)
    compose_profile TEXT NOT NULL DEFAULT '',   -- профиль compose (пусто = основной)
    onec_user TEXT NOT NULL DEFAULT '',         -- пользователь 1С для RLS-вызовов от имени сервиса
    onec_password TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,      -- сервер по умолчанию (без claim `base`)
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Настройки шлюза: opencode_project_root, opencode_gateway_url,
-- opencode_gateway_password — ключи добавляются в runtime через server_settings.
