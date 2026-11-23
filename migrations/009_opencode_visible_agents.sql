-- Фильтрация агентов на клиенте (форма 1С / AI-1C):
-- JSON-массив имён агентов, которые отдаёт шлюз в GET /api/agent.
-- Пусто = все агенты сервера видны.
ALTER TABLE opencode_servers ADD COLUMN visible_agents TEXT NOT NULL DEFAULT '';
