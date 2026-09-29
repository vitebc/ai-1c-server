CREATE TABLE IF NOT EXISTS model_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    models TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_model_providers_name ON model_providers(name);
