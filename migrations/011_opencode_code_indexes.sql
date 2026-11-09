-- Назначение выгрузок code-index на сервер OpenCode:
-- JSON-массив алиасов (ka2, erp, ktm, upp, obrabotki, erp_ext, ...).
-- Используется при генерации opencode.jsonc: mcp.servers.ci_<алиас>
-- и per-agent permissions (deny ci_* / allow назначенные).
ALTER TABLE opencode_servers ADD COLUMN code_indexes TEXT NOT NULL DEFAULT '';
