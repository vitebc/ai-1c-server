-- 012_opencode_requests_usage.sql
-- Агент, токены и длительность раунда (из Session.Info OpenCode после завершения).
-- Заполняются фоновой задачей шлюза: строка появляется сразу при отправке
-- промпта, а usage-поля подставляются через несколько секунд.

ALTER TABLE opencode_requests ADD COLUMN agent TEXT;
ALTER TABLE opencode_requests ADD COLUMN tokens_in INTEGER;
ALTER TABLE opencode_requests ADD COLUMN tokens_out INTEGER;
ALTER TABLE opencode_requests ADD COLUMN duration_ms INTEGER;
