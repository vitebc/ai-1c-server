-- 011_opencode_requests_text.sql
-- Текст промпта (поле "text" JSON-тела POST /api/session/{id}/prompt).
-- Храним в БД: кольцевой буфер логов теряет данные при рестарте.

ALTER TABLE opencode_requests ADD COLUMN prompt TEXT;
