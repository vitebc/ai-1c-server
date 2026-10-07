-- 007_agent_changes_toggle.sql
-- Расширяем допустимые action аудита Agent Studio: 'toggle' (вкл/выкл паттерна).
-- CHECK не редактируется на месте — пересоздаём таблицу, копируя данные.

CREATE TABLE IF NOT EXISTS agent_changes_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    user_id TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    entity_type TEXT NOT NULL CHECK(entity_type IN ('agent', 'skill', 'pattern')),
    entity_name TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete', 'revert', 'toggle')),
    git_commit_hash TEXT NOT NULL,
    diff_summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO agent_changes_new (id, timestamp, user_id, username, entity_type, entity_name, action, git_commit_hash, diff_summary, created_at)
SELECT id, timestamp, user_id, username, entity_type, entity_name, action, git_commit_hash, diff_summary, created_at FROM agent_changes;

DROP TABLE agent_changes;
ALTER TABLE agent_changes_new RENAME TO agent_changes;

CREATE INDEX IF NOT EXISTS idx_agent_changes_ts ON agent_changes(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_agent_changes_user ON agent_changes(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_changes_entity ON agent_changes(entity_type, entity_name);
