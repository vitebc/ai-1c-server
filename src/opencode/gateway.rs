//! Listener :9020 — единая точка входа формы 1С в OpenCode.
//!
//! * Маршрутизация по базе: X-1C-Base → ?base= → claim `base` JWT → сервер
//!   по умолчанию (или совпадение имени базы в bases). Неизвестная база — 404
//!   со списком настроенных.
//! * Прокси OpenCode API (REST/SSE) с реестром сессий: при POST /api/session
//!   шлюз запоминает sessionID → {base, sub, JWT, exp}; обновляет при каждом
//!   prompt/wait/message. TTL до exp. Рестарт шлюза = сессии без JWT
//!   (инструменты недоступны до следующего промпта — осознанно).
//! * RLS-мост /onec/rpc: плагин 1c-tools шлёт X-OpenCode-Token + sessionID,
//!   шлюз сверяет токен, берёт JWT пользователя из реестра и форвардит JSON-RPC
//!   в 1С {base}/hs/mcp/rpc с Authorization: Bearer <JWT> (per-user RLS).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::AppState;
use crate::opencode::{basic_auth, plugin_token};

// ─── реестр сессий ──────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct SessionEntry {
    server_id: String,
    base: Option<String>,
    sub: Option<String>,
    jwt: Option<String>,
    exp: u64, // unix-секунды; 0 = без TTL
}

type SessionsMap = HashMap<String, SessionEntry>;

static SESSIONS: std::sync::LazyLock<Mutex<SessionsMap>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn record_session(session_id: &str, server_id: &str, base: Option<String>, sub: Option<String>, jwt: Option<String>, exp: u64) {
    let mut map = SESSIONS.lock().unwrap();
    if map.len() > 500 {
        let now = now_secs();
        map.retain(|_, e| e.exp == 0 || e.exp > now);
    }
    map.insert(
        session_id.to_string(),
        SessionEntry { server_id: server_id.to_string(), base, sub, jwt, exp },
    );
}

fn lookup_session(session_id: &str) -> Option<SessionEntry> {
    let map = SESSIONS.lock().unwrap();
    let e = map.get(session_id)?;
    if e.exp != 0 && e.exp <= now_secs() {
        return None;
    }
    Some(e.clone())
}

/// Снимок для UI (без JWT).
pub fn sessions_snapshot() -> Vec<Value> {
    let map = SESSIONS.lock().unwrap();
    let now = now_secs();
    map.iter()
        .filter(|(_, e)| e.exp == 0 || e.exp > now)
        .map(|(id, e)| {
            json!({
                "session_id": id,
                "server": e.server_id,
                "base": e.base,
                "user": e.sub,
                "has_jwt": e.jwt.is_some(),
                "expires_at": if e.exp == 0 { Value::Null } else { json!(e.exp) },
            })
        })
        .collect()
}

pub fn drop_session(session_id: &str) -> bool {
    SESSIONS.lock().unwrap().remove(session_id).is_some()
}

// ─── маршрутизация по базе ──────────────────────────────────────────

#[derive(Debug, Clone)]
struct ServerInfo {
    id: String,
    name: String,
    url: String,
    username: String,
    password: String,
    bases: Vec<String>,
}

fn load_servers(db: &crate::db::Database) -> (Vec<ServerInfo>, Option<ServerInfo>) {
    let pick = |r: &rusqlite::Row| -> rusqlite::Result<(String, String, String, String, String, String)> {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
    };
    let to_info = |(id, name, url, username, password, bases_raw): (String, String, String, String, String, String)| ServerInfo {
        id,
        name,
        url: url.trim_end_matches('/').to_string(),
        username,
        password,
        bases: serde_json::from_str(&bases_raw).unwrap_or_default(),
    };
    let mut stmt = db
        .conn
        .prepare("SELECT id, name, url, username, password, bases FROM opencode_servers WHERE enabled = 1 ORDER BY name")
        .unwrap();
    let servers: Vec<ServerInfo> = stmt
        .query_map([], pick)
        .unwrap()
        .flatten()
        .map(to_info)
        .collect();
    let default = db
        .conn
        .query_row(
            "SELECT id, name, url, username, password, bases FROM opencode_servers WHERE enabled = 1 AND is_default = 1 LIMIT 1",
            [],
            pick,
        )
        .ok()
        .map(to_info);
    (servers, default)
}

/// Базовый URL 1С для имени базы (мапа agent/bases.conf + ONEC_BASES из .env).
async fn resolve_onec_url(state: &AppState, base: &str) -> Option<String> {
    let root = {
        let db = state.db.lock().await;
        crate::api::admin::agent_files::project_root(&db)
    };
    if let Ok(raw) = std::fs::read_to_string(root.join("backend").join("bases.conf")) {
        for (name, url) in crate::api::admin::agent_backend::parse_bases_lines_pub(&raw) {
            if name.eq_ignore_ascii_case(base) {
                return Some(url);
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(root.join(".env")) {
        for line in text.lines() {
            let t = line.trim().strip_prefix("export ").unwrap_or(line.trim());
            if let Some((k, v)) = t.split_once('=') {
                if k.trim() == "ONEC_BASES" {
                    let mut v = v.trim().to_string();
                    if v.len() >= 2
                        && ((v.starts_with('"') && v.ends_with('"'))
                            || (v.starts_with('\'') && v.ends_with('\'')))
                    {
                        v = v[1..v.len() - 1].to_string();
                    }
                    for (name, url) in crate::api::admin::agent_backend::parse_bases_lines_pub(&v) {
                        if name.eq_ignore_ascii_case(base) {
                            return Some(url);
                        }
                    }
                }
            }
        }
    }
    None
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(h) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(h);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// JWT пользователя 1С: HS256, секрет = jwt_secret админки (единый с бэкендом),
/// aud=mcp обязателен. Возвращает (sub, exp, base).
fn decode_onec_jwt(db: &crate::db::Database, token: &str) -> Option<(String, u64, Option<String>)> {
    use jsonwebtoken::{DecodingKey, Validation};
    let secret = crate::auth::jwt_secret_pub(db);
    if secret.is_empty() {
        return None;
    }
    let mut validation = Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.set_audience(&["mcp"]);
    let data = jsonwebtoken::decode::<Value>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()?;
    let claims = data.claims;
    let sub = claims.get("sub").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if sub.is_empty() {
        return None;
    }
    let exp = claims.get("exp").and_then(|v| v.as_u64()).unwrap_or(0);
    let base = claims.get("base").and_then(|v| v.as_str()).map(|s| s.to_lowercase());
    Some((sub, exp, base))
}

/// Только claim `base` из JWT (без проверки подписи — для маршрутизации).
fn base_from_jwt_only(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    use base64::Engine;
    let b64 = parts[1].replace('-', "+").replace('_', "/");
    let padded = match b64.len() % 4 {
        2 => format!("{b64}=="),
        3 => format!("{b64}="),
        _ => b64,
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(&padded).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("base").and_then(|b| b.as_str()).map(|s| s.to_lowercase())
}

/// Имя базы из запроса: X-1C-Base → ?base= → claim `base` JWT.
fn base_from_request(headers: &axum::http::HeaderMap, query: &str, jwt: Option<&str>) -> Option<String> {
    if let Some(v) = headers.get("x-1c-base").and_then(|v| v.to_str().ok()) {
        if !v.trim().is_empty() {
            return Some(v.trim().to_lowercase());
        }
    }
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == "base" && !v.is_empty() {
                return Some(urldecode(v).to_lowercase());
            }
        }
    }
    jwt.and_then(base_from_jwt_only)
}

// ─── прокси OpenCode API (REST + SSE) ───────────────────────────────

async fn gateway_any(
    State(state): State<Arc<AppState>>,
    req: axum::extract::Request,
) -> Response {
    use axum::body::to_bytes;
    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let uri = parts.uri.clone();
    let headers = parts.headers.clone();

    let bytes = match to_bytes(body, 10 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "body too large").into_response(),
    };

    let path = uri.path().to_string();
    let query = uri.query().map(|q| q.to_string()).unwrap_or_default();

    // Заполняется блоком допуска ниже (декодированный JWT формы, если есть).
    let mut jwt_info_global: Option<(String, u64, Option<String>)> = None;

    // JWT формы: Bearer из заголовка ИЛИ ?onec_token= (BSL не может переопределить
    // Authorization — он занят Basic-конструктором HTTPСоединения).
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t.trim().to_string())
        .or_else(|| query_param(&query, "onec_token"));

    // Допуск к прокси: только два легитимных клиента.
    // 1) Форма 1С / Витра AI с JWT пользователя 1С (HS256, aud=mcp, валидный exp) —
    //    Bearer или ?onec_token=. Подпись проверяется здесь же (decode_onec_jwt).
    // 2) Витра AI анонимно — статический токен X-Vitra-Token (server_settings.vitra_ai_token).
    //    Такой сессии не будет выдан JWT → /onec/rpc отклонит инструменты 1С (только чтение).
    // Всё остальное (браузер, curl без маркера) — 401.
    {
        let db = state.db.lock().await;
        let jwt_info = bearer.as_deref().and_then(|t| decode_onec_jwt(&db, t));
        let vitra_ok = match crate::opencode::vitra_token(&db) {
            Some(expected) => headers
                .get("x-vitra-token")
                .and_then(|v| v.to_str().ok())
                .map(|p| constant_time_eq(p, &expected))
                .unwrap_or(false),
            None => false, // токен не задан — допуск по Витре выключен
        };
        if jwt_info.is_none() && !vitra_ok {
            let reason = match bearer.as_deref() {
                Some(_) => "неверный JWT",
                None => "нет маркера (JWT / X-Vitra-Token)",
            };
            tracing::warn!(
                "gateway: 401 {} {} — {}",
                method, path, reason
            );
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "доступ только для формы 1С / Витра AI" }))).into_response();
        }
        jwt_info_global = jwt_info;
    }

    // Маршрут сессии: запрос к /api/session/{id}/... ИЛИ
    // /api/experimental/session/{id}/... идёт на сервер, где сессия создана
    // (реестр). Иначе GET-опросы формы (message/form/wait) уходят на сервер по
    // умолчанию и дают 404 SessionNotFound — форма не может передать X-1C-Base
    // (заголовок занят Basic-конструктором HTTPСоединения).
    let session_id = path
        .strip_prefix("/api/session/")
        .or_else(|| path.strip_prefix("/api/experimental/session/"))
        .and_then(|rest| rest.split('/').next().map(|s| s.to_string()))
        .filter(|s| !s.is_empty() && !s.contains(' '));

    let (server, base_routed) = {
        let db = state.db.lock().await;
        let (servers, default) = load_servers(&db);
        let from_registry = session_id.as_deref().and_then(lookup_session).map(|e| e.server_id);
        let base = base_from_request(&headers, &query, bearer.as_deref());
        let server = match from_registry {
            Some(sid) => servers.iter().find(|s| s.id == sid).cloned(),
            None => match &base {
                Some(b) => servers
                    .iter()
                    .find(|s| s.name.eq_ignore_ascii_case(b) || s.bases.iter().any(|x| x.eq_ignore_ascii_case(b)))
                    .cloned(),
                None => default.clone(),
            },
        };
        let server = match server {
            Some(s) => s,
            None => {
                let known: Vec<String> = servers.iter().map(|s| s.name.clone()).collect();
                tracing::warn!(
                    "gateway: 404 {} {} — база не найдена (известны: {})",
                    method, path, known.join(", ")
                );
                return (StatusCode::NOT_FOUND, Json(json!({ "error": "база не найдена", "known_bases": known }))).into_response();
            }
        };
        (server, base)
    };
    let jwt_info = jwt_info_global;

    // Лог обращения: кто (JWT sub или Витра), база, сервер OpenCode, метод/путь.
    tracing::info!(
        "gateway: {} {} — клиент={} base={} → {}",
        method, path,
        jwt_info.as_ref().map(|(s, _, _)| s.clone()).unwrap_or_else(|| "Витра".into()),
        base_routed.clone().unwrap_or_default(),
        server.name
    );

    // Реестр сессий: обновляем при запросах к /api/session/{id}/...
    if let Some((sub, exp, _)) = &jwt_info {
        if let Some(sid) = extract_session_id(&path, &bytes) {
            record_session(
                &sid,
                &server.id,
                jwt_info.as_ref().and_then(|(_, _, b)| b.clone()),
                Some(sub.clone()),
                bearer.clone(),
                *exp,
            );
        }
    }

    // Прокси (SSE — по Content-Type ответа).
    let resp = proxy_raw(
        &reqwest::Client::new(),
        method.clone(),
        &server.url,
        &path,
        &query,
        &basic_auth(&server.username, &server.password),
        (!bytes.is_empty()).then_some(bytes.clone()),
    )
    .await;

    // POST /api/session: запоминаем созданную сессию (id из ответа).
    // OpenCode v2 оборачивает ответ в {data: {...}} — смотрим и туда.
    if method == Method::POST && path == "/api/session" {
        if let Some((status, body_bytes)) = peek_json(&resp) {
            if status.is_success() {
                if let Ok(v) = serde_json::from_slice::<Value>(&body_bytes) {
                    let sid = v.get("id")
                        .or_else(|| v.get("data").and_then(|d| d.get("id")))
                        .and_then(|i| i.as_str());
                    if let Some(sid) = sid {
                        record_session(
                            sid,
                            &server.id,
                            jwt_info.as_ref().and_then(|(_, _, b)| b.clone()),
                            jwt_info.as_ref().map(|(s, _, _)| s.clone()),
                            bearer,
                            jwt_info.map(|(_, e, _)| e).unwrap_or(0),
                        );
                    }
                }
            }
        }
    }

    resp
}

/// sessionID из пути /api/session/{id}/... или из JSON-тела (поле id).
fn extract_session_id(path: &str, body: &bytes::Bytes) -> Option<String> {
    if let Some(rest) = path.strip_prefix("/api/session/") {
        let seg = rest.split('/').next()?;
        if !seg.is_empty() && !seg.contains(' ') {
            return Some(seg.to_string());
        }
    }
    if let Ok(v) = serde_json::from_slice::<Value>(body) {
        if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
    }
    None
}

/// Если ответ — небольшой JSON, возвращаем (status, body) для реестра.
fn peek_json(resp: &Response) -> Option<(StatusCode, bytes::Bytes)> {
    let status = resp.status();
    if !status.is_success() {
        return None;
    }
    let ct = resp
        .headers()
        .get(header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .to_string();
    if !ct.contains("application/json") {
        return None;
    }
    // Body уже собран (не SSE) — proxy_raw кладёт его в extensions.
    resp.extensions().get::<bytes::Bytes>().cloned().map(|b| (status, b))
}

/// Прокси: стримит SSE, собирает JSON. Ответ-JSON дополнительно кладёт body
/// в extensions (для записи сессии).
async fn proxy_raw(
    client: &reqwest::Client,
    method: Method,
    server_url: &str,
    path: &str,
    query: &str,
    auth: &str,
    body: Option<bytes::Bytes>,
) -> Response {
    let mut url = format!("{server_url}{path}");
    if !query.is_empty() {
        let q: String = query
            .split('&')
            .filter(|p| !p.starts_with("base=") && !p.starts_with("onec_token="))
            .collect::<Vec<_>>()
            .join("&");
        if !q.is_empty() {
            url.push_str(&format!("?{q}"));
        }
    }

    let mut req = client.request(method.clone(), &url);
    req = req.header("Authorization", auth);
    if let Some(b) = &body {
        if !b.is_empty() {
            req = req.header(header::CONTENT_TYPE, "application/json").body(b.clone());
        }
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("OpenCode: {e}")).into_response(),
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if content_type.as_deref() == Some("text/event-stream") {
        // Стриминг: отдаём по чанкам.
        use futures::StreamExt;
        let stream = resp
            .bytes_stream()
            .map(|r| Ok::<_, std::io::Error>(r.unwrap_or_default()))
            .boxed();
        return Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header("Cache-Control", "no-cache")
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "stream").into_response());
    }

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("OpenCode: {e}")).into_response(),
    };
    let mut builder = Response::builder().status(status);
    if let Some(ct) = &content_type {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }
    let resp = match builder.body(Body::from(bytes.clone())) {
        Ok(r) => r,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "response").into_response(),
    };
    // Для JSON-ответов кладём body в extensions (реестр сессий).
    let mut resp = resp;
    resp.extensions_mut().insert(bytes);
    resp
}

// ─── RLS-мост /onec/rpc ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct OnecRpcBody {
    session_id: String,
    #[serde(default)]
    base: Option<String>,
    params: Value, // JSON-RPC params: {name, arguments}
}

/// Плагин 1c-tools → шлюз → 1С. Токен плагина в X-OpenCode-Token.
async fn onec_rpc(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<OnecRpcBody>,
) -> Response {
    // 1. Токен плагина → имя сервера.
    let token = match headers.get("x-opencode-token").and_then(|v| v.to_str().ok()) {
        Some(t) => t.to_string(),
        None => {
            tracing::warn!("onec-rpc: 401 нет X-OpenCode-Token");
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "нет X-OpenCode-Token" }))).into_response();
        }
    };
    let server_name = {
        let db = state.db.lock().await;
        let secret = crate::auth::jwt_secret_pub(&db);
        let mut stmt = db.conn.prepare("SELECT name FROM opencode_servers").unwrap();
        let names: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().flatten().collect();
        names.into_iter().find(|n| plugin_token(&secret, n) == token)
    };
    let server_name = match server_name {
        Some(n) => n,
        None => {
            tracing::warn!("onec-rpc: 401 неверный токен плагина");
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "неверный токен плагина" }))).into_response();
        }
    };

    // 1b. Если пароль шлюза задан — контейнер обязан предъявить PEPK-токен
    // (X-Onec-Pepek = пароль). X-OpenCode-Token идентифицирует сервер, но не
    // аутентифицирует канал; без пароля шлюза проверка пропускается.
    {
        let db = state.db.lock().await;
        if let Some(expected) = crate::opencode::gateway_password(&db) {
            let pepek = headers.get("x-onec-pepek").and_then(|v| v.to_str().ok()).unwrap_or_default();
            if !constant_time_eq(pepek, &expected) {
                tracing::warn!("onec-rpc: 401 нет PEPK-токена контейнера (server={})", server_name);
                return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "нет PEPK-токена контейнера" }))).into_response();
            }
        }
    }

    // 2. Сессия → JWT пользователя + база.
    let entry = match lookup_session(&body.session_id) {
        Some(e) => e,
        None => {
            tracing::warn!("onec-rpc: 401 сессия {} не найдена или истекла", body.session_id);
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "сессия не найдена или истекла — отправьте новый промпт" }))).into_response()
        }
    };
    if entry.jwt.is_none() {
        tracing::warn!("onec-rpc: 401 у сессии {} нет JWT пользователя 1С", body.session_id);
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "у сессии нет JWT пользователя 1С — отправьте новый промпт" }))).into_response();
    }

    // 3. База: явная → из сессии → первая из bases сервера.
    // Токен шлём в 1С переподписанным: iat — миллисекунды (как у ТокенДоступа
    // 1С; 8.3.27 отклоняет iat в секундах), exp — не меньше +5 минут, чтобы
    // токен сессии жил дольше исходного и RLS работал до истечения оригинала.
    let iat_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let exp_s = entry.exp.max(iat_ms / 1000 + 300); // exp — секунды; минимум +5 мин
    let base_claim = body.base.clone().or(entry.base.clone()).map(|b| b.to_lowercase());
    let new_claims = json!({
        "iss": "1c-ai-chat",
        "aud": ["mcp"],
        "sub": entry.sub,
        "iat": iat_ms,
        "exp": exp_s,
        "base": base_claim,
    });
    let secret = {
        let db = state.db.lock().await;
        crate::auth::jwt_secret_pub(&db)
    };
    let jwt = if secret.is_empty() {
        entry.jwt.clone().unwrap_or_default()
    } else {
        use jsonwebtoken::{EncodingKey, Header};
        match jsonwebtoken::encode(&Header::new(jsonwebtoken::Algorithm::HS256), &new_claims, &EncodingKey::from_secret(secret.as_bytes())) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("onec-rpc: не удалось переподписать JWT: {e}");
                entry.jwt.clone().unwrap_or_default()
            }
        }
    };
    let bases_raw: Option<String> = {
        let db = state.db.lock().await;
        db.conn
            .query_row("SELECT bases FROM opencode_servers WHERE name = ?1", [&server_name], |r| r.get::<_, String>(0))
            .ok()
    };
    let bases_raw = match bases_raw {
        Some(r) => r,
        None => return (StatusCode::NOT_FOUND, Json(json!({ "error": "сервер не найден" }))).into_response(),
    };
    let bases: Vec<String> = serde_json::from_str(&bases_raw).unwrap_or_default();
    let base_final = match base_claim {
        Some(b) => b,
        None => bases.first().cloned().unwrap_or_default(),
    };
    if base_final.is_empty() {
        tracing::warn!("onec-rpc: 400 база не указана и не задана у сервера {}", server_name);
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "база не указана и не задана у сервера" }))).into_response();
    }
    // resolve_onec_url сам берёт db-лок — вызываем БЕЗ удержанного лока.
    let onec_url = match resolve_onec_url(&state, &base_final).await {
        Some(u) => u.trim_end_matches('/').to_string(),
        None => {
            tracing::warn!("onec-rpc: 404 база {base_final:?} не найдена в мапе ONEC_BASES");
            return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("база {base_final:?} не найдена в мапе ONEC_BASES") }))).into_response();
        }
    };

    // 4. JSON-RPC в 1С под JWT пользователя (per-user RLS).
    // 1С /hs/mcp/rpc — MCP-совместимый: {jsonrpc, id, method: "tools/call",
    // params: {name, arguments}}. Плагин шлёт params.name/arguments.
    let rpc_url = format!("{}/hs/mcp/rpc", onec_url);
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": body.params,
    });
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(120)).build() {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    };
    let resp = client
        .post(&rpc_url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {jwt}"))
        .json(&payload)
        .send()
        .await;
    match resp {
        Ok(r) => {
            let status = r.status();
            let text = r.text().await.unwrap_or_default();
            tracing::info!(
                "onec-rpc: server={} base={} tool={} → {}",
                server_name,
                base_final,
                body.params.get("name").and_then(|n| n.as_str()).unwrap_or("?"),
                status
            );
            match serde_json::from_str::<Value>(&text) {
                Ok(v) => (status, Json(v)).into_response(),
                Err(_) => (status, text).into_response(),
            }
        }
        Err(e) => {
            tracing::warn!("onec-rpc: 502 server={} base={}: {}", server_name, base_final, e);
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("1С: {e}") }))).into_response()
        }
    }
}

/// Значение query-параметра (первое вхождение) или None.
fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key && !v.is_empty() {
                return Some(urldecode(v));
            }
        }
    }
    None
}

/// Сравнение строк за константное время (для секретов).
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

// ─── health / app ───────────────────────────────────────────────────

/// Публичный health: только «шлюз жив». Без списка серверов и сессий —
/// это информационное раскрытие, а реальный статус админка берёт из
/// /api/admin/opencode/status (там же зонды {url}/global/health).
async fn gateway_health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "gateway": "opencode",
    }))
}

pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", axum::routing::get(gateway_health))
        .route("/onec/rpc", axum::routing::post(onec_rpc))
        // Всё остальное — прокси OpenCode API (REST + SSE).
        .fallback(any(gateway_any))
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024))
        .with_state(state)
}
