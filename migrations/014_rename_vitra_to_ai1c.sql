-- Переименование: Vitra AI → AI-1C.
-- 1) Токен анонимного режима: server_settings.vitra_ai_token → ai1c_ai_token.
-- 2) История статистики: opencode_requests.client 'vitra' → 'ai1c'.

UPDATE server_settings SET key = 'ai1c_ai_token' WHERE key = 'vitra_ai_token';

UPDATE opencode_requests SET client = 'ai1c' WHERE client = 'vitra';
