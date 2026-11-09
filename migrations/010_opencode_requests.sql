-- 010_opencode_requests.sql
-- Статистика запросов OpenCode: по одному записью на отправленный промпт
-- (POST /api/session/{id}/prompt через шлюз :9020). client — кто шлёт:
-- 'onec' (форма 1С, JWT пользователя) или 'vitra' (Витра AI, X-Vitra-Token).

CREATE TABLE IF NOT EXISTS opencode_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,                          -- ISO UTC, момент отправки промпта
    client TEXT NOT NULL,                      -- 'onec' | 'vitra'
    user_id TEXT,                              -- sub из JWT пользователя 1С (NULL для Витры)
    base TEXT,                                 -- маршрутизированная база 1С (claim/header/?)
    server TEXT NOT NULL,                      -- имя сервера OpenCode
    path TEXT NOT NULL,                        -- путь запроса
    status INTEGER                             -- HTTP-статус ответа OpenCode
);

CREATE INDEX IF NOT EXISTS idx_opencode_requests_ts ON opencode_requests(ts);
