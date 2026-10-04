-- 006_agent_changes.sql
-- Аудит изменений агентов/скиллов/паттернов Agent Studio с git-версионированием.
-- Каждая запись = один git-коммит в репозитории 1c-ai-agent (backend/agents|skills|patterns).

CREATE TABLE IF NOT EXISTS agent_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    user_id TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    entity_type TEXT NOT NULL CHECK(entity_type IN ('agent', 'skill', 'pattern')),
    entity_name TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete', 'revert')),
    git_commit_hash TEXT NOT NULL,
    diff_summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_changes_ts ON agent_changes(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_agent_changes_user ON agent_changes(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_changes_entity ON agent_changes(entity_type, entity_name);
