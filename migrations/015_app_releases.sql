-- Приложение: релизы десктоп-клиента (Tauri updater) + heartbeat клиентов.
-- Заменяет модель client_versions/clients (ручные URL+checksum): файл живёт на сервере,
-- подпись Tauri проверяется клиентом, sha256 — контрольная сумма файла на сервере.

CREATE TABLE IF NOT EXISTS app_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,                 -- нормализованный semver (1.0.3)
    platform TEXT NOT NULL,                -- linux | windows | darwin
    arch TEXT NOT NULL DEFAULT 'x86_64',   -- x86_64 | aarch64
    channel TEXT NOT NULL DEFAULT 'stable',-- stable | beta
    file_name TEXT NOT NULL UNIQUE,        -- имя файла в data/releases/
    original_name TEXT NOT NULL,           -- исходное имя (AI-1C_1.0.3_x86_64.AppImage)
    signature TEXT NOT NULL,               -- .sig от tauri signer (base64)
    sha256 TEXT NOT NULL,                  -- hex контрольная сумма файла
    size INTEGER NOT NULL DEFAULT 0,       -- байты
    notes TEXT NOT NULL DEFAULT '',        -- release notes для клиента
    required INTEGER NOT NULL DEFAULT 0,   -- принудительное обновление
    published INTEGER NOT NULL DEFAULT 1,  -- 0 = черновик (не отдаётся в /api/update/check)
    downloads INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(version, platform, arch, channel)
);

-- Клиенты, видевшие приложение (heartbeat). Лёгкая модель: только факт жизни.
CREATE TABLE IF NOT EXISTS app_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL UNIQUE,        -- uuid клиента (генерируется клиентом)
    version TEXT NOT NULL DEFAULT '',      -- текущая версия
    platform TEXT NOT NULL DEFAULT '',     -- linux | windows | darwin
    hostname TEXT NOT NULL DEFAULT '',
    user_name TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_releases_lookup
    ON app_releases(platform, arch, channel, published);
CREATE INDEX IF NOT EXISTS idx_app_clients_last_seen
    ON app_clients(last_seen_at DESC);
