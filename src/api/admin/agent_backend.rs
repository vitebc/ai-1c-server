//! Runtime control for the `1c-ai-agent` project: docker compose lifecycle,
//! service logs, `.env` config (allowlist), and live read-through of the
//! backend's own `GET /agents`, `GET /skills`, `GET /health`.
//!
//! Only `docker compose` is driven (no local uvicorn management).
//! Compose commands are an allowlist: `ps`, `up`, `stop`, `restart`, `logs`.
//! All commands run with `--project-directory <root>` and a timeout.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, Query, Request, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::super::AppState;
use super::agent_files::default_root;

const CMD_TIMEOUT: Duration = Duration::from_secs(120);

/// Compose services managed here (subset of docker-compose.yml).
const ALLOWED_SERVICES: &[&str] = &["postgres", "backend", "tei", "mcp-proxy"];
const ALLOWED_PROFILES: &[&str] = &["rag", "onec"];

/// `.env` keys editable via UI (from `.env.example` + compose overrides).
/// Secrets are masked on read.
const ENV_ALLOWLIST: &[&str] = &[
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
    "LLM_TEMPERATURE",
    "LLM_TOP_P",
    "LLM_TOP_K",
    "LLM_REPETITION_PENALTY",
    "LLM_ENABLE_THINKING",
    "AGENT_MAX_ROUNDS",
    "DEFAULT_AGENT",
    "EMBEDDINGS_PROVIDER",
    "EMBEDDINGS_BASE_URL",
    "EMBEDDINGS_MODEL",
    "TEI_BASE_URL",
    "TEI_MODEL_ID",
    "TEI_PORT",
    "DATABASE_URL",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "POSTGRES_PORT",
    "BACKEND_PORT",
    "ONEC_MODE",
    "ONEC_MCP_URL",
    "ONEC_MCP_URL_COMPOSE",
    "ONEC_TOKEN",
    "MCP_ONEC_URL",
    "MCP_ONEC_URL_COMPOSE",
    "MCP_AUTH_MODE",
    "MCP_ONEC_USERNAME",
    "MCP_ONEC_PASSWORD",
    "MCP_PROXY_PORT",
    "MCP_PROXY_IMAGE",
    "ONEC_BASES",
];

fn is_secret(key: &str) -> bool {
    key.contains("PASSWORD")
        || key.contains("API_KEY")
        || key.contains("TOKEN")
        || key.contains("SECRET")
}

fn project_root(db: &crate::db::Database) -> PathBuf {
    let custom: Option<String> = db
        .conn
        .query_row(
            "SELECT value FROM server_settings WHERE key = 'agent_project_root'",
            [],
            |row| row.get(0),
        )
        .ok();
    custom.map(PathBuf::from).unwrap_or_else(default_root)
}

fn backend_url(_db: &crate::db::Database, root: &std::path::Path) -> String {
    // Единая схема: корень проекта (agent_project_root, выбирается в Agent
    // Studio) + его .env. Dev/prod различаются только директорией и своим
    // BACKEND_PORT в своём файле — как вкладка Env (env_list/env_put).
    let port = parse_dotenv(&root.join(".env"))
        .into_iter()
        .find(|(k, _)| k == "BACKEND_PORT")
        .map(|(_, v)| v)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "8000".into());
    format!("http://localhost:{port}", port = port.trim())
}

fn validate_services(list: &[String]) -> Result<(), String> {
    for s in list {
        if !ALLOWED_SERVICES.contains(&s.as_str()) {
            return Err(format!("unknown service {s:?}"));
        }
    }
    Ok(())
}

fn validate_profiles(list: &[String]) -> Result<(), String> {
    for p in list {
        if !ALLOWED_PROFILES.contains(&p.as_str()) {
            return Err(format!("unknown profile {p:?}"));
        }
    }
    Ok(())
}

async fn compose(root: &std::path::Path, args: &[&str]) -> Result<(bool, String), String> {
    let mut cmd = tokio::process::Command::new("docker");
    cmd.arg("compose")
        .arg("--project-directory")
        .arg(root)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let out = tokio::time::timeout(CMD_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "docker compose timed out (120s)".to_string())?
        .map_err(|e| format!("failed to run docker: {e}"))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push_str(&format!("\n[stderr]\n{err}"));
    }
    Ok((out.status.success(), text))
}

// ─── status ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ComposeService {
    pub name: String,
    pub state: String,
    pub health: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BackendStatus {
    pub root: String,
    pub root_exists: bool,
    pub compose_available: bool,
    pub services: Vec<ComposeService>,
    pub backend_reachable: bool,
    pub backend_health: Option<Value>,
    pub backend_url: String,
}

pub async fn status(State(state): State<Arc<AppState>>) -> Json<BackendStatus> {
    let (root, url) = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        let url = backend_url(&db, &root);
        (root, url)
    };
    let root_exists = root.join("docker-compose.yml").is_file();

    let (compose_available, services) = match compose(&root, &["ps", "--format", "json"]).await {
        Ok((_, text)) => {
            let mut svcs = Vec::new();
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || !line.starts_with('{') {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    svcs.push(ComposeService {
                        name: v
                            .get("Service")
                            .or_else(|| v.get("Name"))
                            .and_then(|x| x.as_str())
                            .unwrap_or("?")
                            .to_string(),
                        state: v
                            .get("State")
                            .and_then(|x| x.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        health: v.get("Health").and_then(|x| x.as_str()).map(str::to_string),
                    });
                }
            }
            (true, svcs)
        }
        Err(_) => (false, Vec::new()),
    };

    let (backend_reachable, backend_health) = match tokio::time::timeout(
        Duration::from_secs(5),
        reqwest::get(format!("{url}/health")),
    )
    .await
    {
        Ok(Ok(resp)) => {
            let body: Option<Value> = resp.json().await.ok();
            (true, body)
        }
        _ => (false, None),
    };

    Json(BackendStatus {
        root: root.to_string_lossy().to_string(),
        root_exists,
        compose_available,
        services,
        backend_reachable,
        backend_health,
        backend_url: url,
    })
}

// ─── lifecycle ───

#[derive(Debug, Deserialize)]
pub struct LifecycleBody {
    #[serde(default)]
    pub services: Vec<String>,
    #[serde(default)]
    pub profiles: Vec<String>,
}

fn profile_args(profiles: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for p in profiles {
        out.push("--profile".to_string());
        out.push(p.clone());
    }
    out
}

async fn lifecycle(
    state: &Arc<AppState>,
    action: &str,
    body: LifecycleBody,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    validate_services(&body.services).map_err(|e| super::BadRequest(e).into_response())?;
    validate_profiles(&body.profiles).map_err(|e| super::BadRequest(e).into_response())?;
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    if !root.join("docker-compose.yml").is_file() {
        return Err(
            super::BadRequest("project root has no docker-compose.yml".into()).into_response(),
        );
    }
    let owned: Vec<String>;
    let args: Vec<&str> = match action {
        "up" => {
            owned = std::iter::once("up".to_string())
                .chain(["-d".to_string()])
                .chain(profile_args(&body.profiles))
                .chain(body.services.clone())
                .collect();
            owned.iter().map(String::as_str).collect()
        }
        "stop" => {
            owned = std::iter::once("stop".to_string())
                .chain(body.services.clone())
                .collect();
            owned.iter().map(String::as_str).collect()
        }
        "restart" => {
            owned = std::iter::once("restart".to_string())
                .chain(body.services.clone())
                .collect();
            owned.iter().map(String::as_str).collect()
        }
        _ => return Err(super::BadRequest("unknown action".into()).into_response()),
    };
    tracing::warn!(
        "agent-backend: docker compose {action} services={:?}",
        body.services
    );
    match compose(&root, &args).await {
        Ok((ok, text)) => Ok(Json(json!({ "ok": ok, "output": text }))),
        Err(e) => Err(super::AppError::msg(e).into_response()),
    }
}

pub async fn up(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LifecycleBody>,
) -> Result<Json<Value>, axum::response::Response> {
    lifecycle(&state, "up", body).await
}

pub async fn stop(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LifecycleBody>,
) -> Result<Json<Value>, axum::response::Response> {
    lifecycle(&state, "stop", body).await
}

pub async fn restart(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LifecycleBody>,
) -> Result<Json<Value>, axum::response::Response> {
    lifecycle(&state, "restart", body).await
}

// ─── logs ───

#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    pub service: Option<String>,
    pub tail: Option<usize>,
    #[serde(default)]
    pub timestamps: bool,
    /// Case-insensitive substring filter over log lines (`| grep ...`).
    pub grep: Option<String>,
}

pub async fn logs(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LogsQuery>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let tail = q.tail.unwrap_or(200).clamp(1, 2000).to_string();
    let mut args: Vec<&str> = vec!["logs", "--no-color", "--tail", &tail];
    if q.timestamps {
        args.push("--timestamps");
    }
    if let Some(s) = &q.service {
        if !s.trim().is_empty() {
            validate_services(&[s.clone()]).map_err(|e| super::BadRequest(e).into_response())?;
            args.push(s);
        }
    }
    match compose(&root, &args).await {
        Ok((_, text)) => {
            let log = match q.grep.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(needle) => {
                    let n = needle.to_lowercase();
                    text.lines()
                        .filter(|l| l.to_lowercase().contains(&n))
                        .collect::<Vec<_>>()
                        .join("\n")
                }
                None => text,
            };
            Ok(Json(json!({ "service": q.service, "log": log })))
        }
        Err(e) => Err(super::AppError::msg(e).into_response()),
    }
}

// ─── .env config ───

fn parse_dotenv(path: &std::path::Path) -> Vec<(String, String)> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || !t.contains('=') {
            continue;
        }
        // Handle optional `export ` prefix.
        let t = t.strip_prefix("export ").unwrap_or(t);
        let (k, v) = t.split_once('=').unwrap();
        let k = k.trim().to_string();
        let mut v = v.trim().to_string();
        if v.len() >= 2
            && ((v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\'')))
        {
            v = v[1..v.len() - 1].to_string();
        }
        if !k.is_empty() {
            out.push((k, v));
        }
    }
    out
}

#[derive(Debug, Serialize)]
pub struct EnvEntry {
    pub key: String,
    /// Masked (`***`) for secrets, `None` when absent from file.
    pub value: Option<String>,
    pub masked: bool,
    pub present: bool,
}

pub async fn env_list(State(state): State<Arc<AppState>>) -> Json<Vec<EnvEntry>> {
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let parsed = parse_dotenv(&root.join(".env"));
    let map: std::collections::HashMap<_, _> = parsed.into_iter().collect();
    Json(
        ENV_ALLOWLIST
            .iter()
            .map(|k| {
                let secret = is_secret(k);
                match map.get(*k) {
                    Some(v) => EnvEntry {
                        key: k.to_string(),
                        value: if secret {
                            Some("***".into())
                        } else {
                            Some(v.clone())
                        },
                        masked: secret,
                        present: true,
                    },
                    None => EnvEntry {
                        key: k.to_string(),
                        value: None,
                        masked: secret,
                        present: false,
                    },
                }
            })
            .collect(),
    )
}

#[derive(Debug, Deserialize)]
pub struct EnvPut {
    pub key: String,
    pub value: String,
}

pub async fn env_put(
    State(state): State<Arc<AppState>>,
    Json(body): Json<EnvPut>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    if !ENV_ALLOWLIST.contains(&body.key.as_str()) {
        return Err(
            super::BadRequest(format!("key {:?} is not editable", body.key)).into_response(),
        );
    }
    if body.value.contains('\n') {
        return Err(super::BadRequest("value must be a single line".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = root.join(".env");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut replaced = false;
    let mut out_lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let bare = t.strip_prefix("export ").unwrap_or(t);
        if let Some((k, _)) = bare.split_once('=') {
            if k.trim() == body.key {
                out_lines.push(format!("{}={}", body.key, body.value));
                replaced = true;
                continue;
            }
        }
        out_lines.push(line.to_string());
    }
    if !replaced {
        if !out_lines.is_empty() {
            out_lines.push(String::new());
        }
        out_lines.push(format!("{}={}", body.key, body.value));
    }
    let mut content = out_lines.join("\n");
    content.push('\n');
    std::fs::write(&path, content)
        .map_err(|e| super::AppError::msg(format!("write .env: {e}")).into_response())?;
    tracing::warn!(
        "agent-backend: .env key {} updated (restart backend to apply)",
        body.key
    );
    Ok(Json(
        json!({ "ok": true, "key": body.key, "restart_required": true }),
    ))
}

// ─── live read-through (backend's own view) ───

/// GET без авторизации.
async fn proxy_get(url: &str) -> Result<Value, String> {
    let resp = tokio::time::timeout(Duration::from_secs(10), reqwest::get(url))
        .await
        .map_err(|_| "backend request timed out".to_string())?
        .map_err(|e| format!("backend unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("backend returned {}", resp.status()));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("invalid backend JSON: {e}"))
}

/// GET с JWT админки: бэкенд проверяет токен (единый JWT_SECRET) и отдаёт
/// per-user RLS-данные. Токен берём из запроса к админке — без него бэкенд
/// отвечает 401 на защищённые эндпоинты (напр. /tools?base_url=...).
async fn proxy_get_auth(url: &str, bearer: Option<&str>) -> Result<Value, String> {
    let mut req = reqwest::Client::new().get(url);
    if let Some(t) = bearer.filter(|t| !t.is_empty()) {
        req = req.header(reqwest::header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let resp = tokio::time::timeout(Duration::from_secs(10), req.send())
        .await
        .map_err(|_| "backend request timed out".to_string())?
        .map_err(|e| format!("backend unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("backend returned {}", resp.status()));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| format!("invalid backend JSON: {e}"))
}

fn bearer_from(h: &axum::http::HeaderMap) -> Option<String> {
    h.get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t.trim().to_string())
}

pub async fn live_agents(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Json<Value> {
    let (url, bearer) = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        (backend_url(&db, &root), bearer_from(&headers))
    };
    match proxy_get_auth(&format!("{url}/agents"), bearer.as_deref()).await {
        Ok(v) => Json(json!({ "reachable": true, "data": v })),
        Err(e) => Json(json!({ "reachable": false, "error": e })),
    }
}

pub async fn live_skills(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let (url, bearer) = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        (backend_url(&db, &root), bearer_from(&headers))
    };
    let mut target = format!("{url}/skills");
    if let Some(a) = q.get("agent") {
        target.push_str(&format!("?agent={}", urlencoding(a)));
    }
    match proxy_get_auth(&target, bearer.as_deref()).await {
        Ok(v) => Json(json!({ "reachable": true, "data": v })),
        Err(e) => Json(json!({ "reachable": false, "error": e })),
    }
}

/// GET /agent-backend/live/tools — full live ToolRegistry from the backend
/// (`GET /tools`: mock/live + local tools with descriptions).
/// The source of truth for `AGENT.md`/`SKILL.md` `tools:` selectors.
pub async fn live_tools(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(qs): Query<HashMap<String, String>>,
) -> Json<Value> {
    let (url, base_url, bearer) = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        let mut u = format!("{}/tools", backend_url(&db, &root));
        if let Some(b) = qs.get("base_url").filter(|b| !b.is_empty()) {
            u.push_str(&format!("?base_url={}", urlencoding(b)));
        }
        (
            u,
            qs.get("base_url").cloned().filter(|b| !b.is_empty()),
            bearer_from(&headers),
        )
    };
    match proxy_get_auth(&url, bearer.as_deref()).await {
        Ok(mut v) => {
            // base_url из запроса — источник истины для UI (бэкенд может не вернуть его).
            if let Some(obj) = v.as_object_mut() {
                if let Some(b) = base_url {
                    obj.insert("base_url".into(), json!(b));
                }
            }
            Json(json!({ "reachable": true, "data": v }))
        }
        Err(e) => Json(json!({ "reachable": false, "error": e })),
    }
}

/// GET /agent-backend/live/onec-tools — проба live-базы 1С (MCP_ONEC_URL из .env).
/// Шлёт JSON-RPC `tools/list` напрямую в MCP-прокси 1С (Basic auth из
/// MCP_ONEC_USERNAME/PASSWORD) и возвращает количество инструментов или ошибку.
pub async fn onec_tools(State(state): State<Arc<AppState>>) -> Json<Value> {
    let (url, username, password) = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        let env = parse_dotenv(&root.join(".env"));
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        (
            map.get("MCP_ONEC_URL").cloned().unwrap_or_default(),
            map.get("MCP_ONEC_USERNAME").cloned().unwrap_or_default(),
            map.get("MCP_ONEC_PASSWORD").cloned().unwrap_or_default(),
        )
    };

    if url.trim().is_empty() {
        return Json(json!({ "ok": false, "url": "", "error": "MCP_ONEC_URL не задан в .env" }));
    }

    let target = url.trim().trim_end_matches('/');
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/list",
        "params": {}
    });

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Json(json!({ "ok": false, "url": target, "error": e.to_string() })),
    };

    let mut req = client
        .post(target)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(&body);
    if !username.trim().is_empty() {
        let pw: &str = password.trim();
        req = req.basic_auth(username.trim(), Some(pw));
    }

    let resp = match req.send().await {
        Ok(r) => r,
        // Connection refused / timeout / DNS — база реально недоступна.
        Err(e) => return Json(json!({ "ok": false, "url": target, "error": e.to_string() })),
    };

    let status = resp.status();

    // 405/401/403 — сервер отвечает (Streamable HTTP требует session handshake),
    // база жива. Показываем «online» без точного числа тулзов.
    if status.as_u16() == 405 || status.as_u16() == 401 || status.as_u16() == 403 {
        return Json(json!({ "ok": true, "url": target, "tools_count": null, "note": "online" }));
    }

    if !status.is_success() {
        return Json(json!({ "ok": false, "url": target, "error": format!("HTTP {status}") }));
    }

    let text: String = match resp.text().await {
        Ok(t) => t,
        Err(e) => return Json(json!({ "ok": false, "url": target, "error": e.to_string() })),
    };

    // Ответ может быть plain JSON или SSE-фреймом `data: {...}`.
    let json_text = text
        .lines()
        .find_map(|l| {
            let l = l.trim();
            if let Some(d) = l.strip_prefix("data:") {
                Some(d.trim())
            } else if l.starts_with('{') {
                Some(l)
            } else {
                None
            }
        })
        .unwrap_or(&text);

    match serde_json::from_str::<Value>(json_text) {
        Ok(v) => {
            if let Some(err) = v.get("error") {
                return Json(json!({ "ok": false, "url": target, "error": err.to_string() }));
            }
            let tools = v
                .get("result")
                .and_then(|r| r.get("tools"))
                .and_then(|t| t.as_array());
            let count = tools.map(|a| a.len()).unwrap_or(0);
            Json(json!({ "ok": true, "url": target, "tools_count": count }))
        }
        Err(e) => {
            Json(json!({ "ok": false, "url": target, "error": format!("некорректный ответ: {e}") }))
        }
    }
}

fn urlencoding(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ─── bases.conf (мапа баз 1С, hot-reload бэкендом по mtime) ───

fn bases_conf_path(root: &std::path::Path) -> PathBuf {
    root.join("backend").join("bases.conf")
}

/// Разобрать "имя=url;..." (формат ONEC_BASES, см. parse_bases_map в бэкенде).
/// Имя — латиница/цифры/_, URL обязан начинаться с http(s)://: мусорные записи
/// (прерванные правки, переносы строк) отбрасываются, а не ломают таблицу.
pub(crate) fn parse_bases_lines_pub(raw: &str) -> Vec<(String, String)> {
    parse_bases_lines_impl(raw)
}

fn parse_bases_lines(raw: &str) -> Vec<(String, String)> {
    parse_bases_lines_impl(raw)
}

fn parse_bases_lines_impl(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    // Сначала убираем комментарии (строки, начинающиеся с #), чтобы `;` внутри
    // комментария не разрезал данные.
    let no_comments: Vec<&str> = raw
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .collect();
    for line in &no_comments {
        for chunk_raw in line.split(';') {
            let chunk = chunk_raw.trim();
            if chunk.is_empty() {
                continue;
            }
            if let Some((name, url)) = chunk.split_once('=') {
                let name = name.trim().to_lowercase();
                let url = url.trim();
                let name_ok =
                    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
                if name_ok && (url.starts_with("http://") || url.starts_with("https://")) {
                    out.push((name, url.to_string()));
                }
            }
        }
    }
    out
}

fn serialize_bases(entries: &[(String, String)]) -> String {
    entries
        .iter()
        .map(|(n, u)| format!("{n}={u}"))
        .collect::<Vec<_>>()
        .join(";")
}

const BASES_CONF_HEADER: &str =
    "# Мапа баз ONEC_BASES — hot-reload (перечитывается бэкендом по mtime, TTL 2с).\n\
# Формат: \"имя=url;...\". Имя — НРег. Побеждает присланный формой base_url.\n\
# Кривая запись не роняет бэкенд (warning в лог + fallback на предыдущее значение).\n";

#[derive(Debug, Serialize)]
pub struct BaseEntry {
    pub name: String,
    pub url: String,
}

/// GET /agent-backend/bases — активные базы из bases.conf (fallback: ONEC_BASES из .env).
pub async fn bases_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = bases_conf_path(&root);
    if path.is_file() {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let entries: Vec<BaseEntry> = parse_bases_lines(&text)
            .into_iter()
            .map(|(name, url)| BaseEntry { name, url })
            .collect();
        return Json(json!({ "source": "bases.conf", "bases": entries }));
    }

    // Fallback: ONEC_BASES из .env (стартовое значение бэкенда).
    let parsed = parse_dotenv(&root.join(".env"));
    let map: std::collections::HashMap<_, _> = parsed.into_iter().collect();
    let raw = map.get("ONEC_BASES").cloned().unwrap_or_default();
    let entries: Vec<BaseEntry> = parse_bases_lines(&raw)
        .into_iter()
        .map(|(name, url)| BaseEntry { name, url })
        .collect();
    Json(json!({ "source": "env", "bases": entries }))
}

#[derive(Debug, Deserialize)]
pub struct BasePut {
    pub name: String,
    pub url: String,
    /// Старое имя — задано = переименование (PUT /bases/{old_name}).
    #[serde(default)]
    pub old_name: Option<String>,
}

fn validate_base_pair(name: &str, url: &str) -> Result<(), String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("некорректное имя базы (латиница, цифры, _)".into());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("URL должен начинаться с http:// или https://".into());
    }
    Ok(())
}

/// PUT /agent-backend/bases — добавить/обновить базу (hot-reload ≤2с, без рестарта).
pub async fn bases_put(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BasePut>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let name = body.name.trim().to_lowercase();
    let url = body.url.trim().to_string();
    if let Err(e) = validate_base_pair(&name, &url) {
        return Err(super::BadRequest(e).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = bases_conf_path(&root);
    if !path.is_file() {
        return Err(super::BadRequest(
            "backend/bases.conf не найден — создайте его из bases.conf.example".into(),
        )
        .into_response());
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    // Разбираем только строки "имя=url" (комментарии/пустые игнорируются парсером бэкенда).
    let mut entries = parse_bases_lines(&text);
    if let Some(e) = entries.iter_mut().find(|e| e.0 == name) {
        e.1 = url.clone();
    } else {
        entries.push((name.clone(), url.clone()));
    }
    write_bases_conf(&path, &entries)?;
    tracing::info!("agent-backend: bases.conf обновлён — база {name} (hot-reload ≤2с)");
    Ok(Json(json!({ "ok": true, "name": name, "url": url })))
}

/// PUT /agent-backend/bases/{name} — переименовать/обновить базу.
pub async fn bases_put_named(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(old_name): axum::extract::Path<String>,
    Json(body): Json<BasePut>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let old = old_name.to_lowercase();
    let name = body.name.trim().to_lowercase();
    let url = body.url.trim().to_string();
    if let Err(e) = validate_base_pair(&name, &url) {
        return Err(super::BadRequest(e).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = bases_conf_path(&root);
    if !path.is_file() {
        return Err(super::BadRequest("backend/bases.conf не найден".into()).into_response());
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut entries = parse_bases_lines(&text);
    // Переименование: запись со старым именем заменяется новой; если старой записи
    // нет — просто обновляем/добавляем по новому имени.
    if let Some(e) = entries.iter_mut().find(|e| e.0 == old) {
        e.0 = name.clone();
        e.1 = url.clone();
    } else if let Some(e) = entries.iter_mut().find(|e| e.0 == name) {
        e.1 = url.clone();
    } else {
        entries.push((name.clone(), url.clone()));
    }
    write_bases_conf(&path, &entries)?;
    tracing::info!("agent-backend: bases.conf обновлён — база {old} → {name} (hot-reload ≤2с)");
    Ok(Json(json!({ "ok": true, "name": name, "url": url })))
}

/// DELETE /agent-backend/bases/{name} — выключить базу (hot-reload ≤2с).
pub async fn bases_delete(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let name = name.to_lowercase();
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = bases_conf_path(&root);
    if !path.is_file() {
        return Err(super::BadRequest("backend/bases.conf не найден".into()).into_response());
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut entries = parse_bases_lines(&text);
    let before = entries.len();
    entries.retain(|e| e.0 != name);
    if entries.len() == before {
        return Err(
            super::BadRequest(format!("база {name:?} не найдена в bases.conf")).into_response(),
        );
    }
    write_bases_conf(&path, &entries)?;
    tracing::info!("agent-backend: база {name} отключена в bases.conf (hot-reload ≤2с)");
    Ok(Json(json!({ "ok": true, "name": name })))
}

fn write_bases_conf(
    path: &std::path::Path,
    entries: &[(String, String)],
) -> Result<(), axum::response::Response> {
    use axum::response::IntoResponse;
    if let Err(e) = std::fs::write(
        path,
        format!(
            "{BASES_CONF_HEADER}\n{serialized}\n",
            serialized = serialize_bases(entries)
        ),
    ) {
        return Err(super::AppError::msg(format!("write bases.conf: {e}")).into_response());
    }
    Ok(())
}

// ─── search-maps.conf v2 (сервер → базы; '*' — прочие; '!база' — блок) ───

const SEARCH_MAPS_HEADER: &str = "# search-maps v2: сервер=база1,база2 (hot-reload, TTL 2с).\n\
# Управляется из админки (Agent Studio › Search-мапа), ручные правки на хосте переживают деплой.\n\
# База упомянута в >=1 строке сервера — видит только эти серверы. Явный запрет — '!база='.\n\
# База не упомянута нигде — список из '*' (пустая '*' = блок для всех прочих), без '*' — без фильтрации.\n";

/// Эффективный путь мапы: SEARCH_MAPS_FILE из agent/.env (если задан), иначе
/// root/backend/search-maps.conf — зеркало search_maps_file() бэкенда.
fn search_maps_conf_path(root: &std::path::Path) -> PathBuf {
    let custom = parse_dotenv(&root.join(".env"))
        .into_iter()
        .find(|(k, _)| *k == "SEARCH_MAPS_FILE")
        .map(|(_, v)| v);
    match custom.as_deref().map(str::trim) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => root.join("backend").join("search-maps.conf"),
    }
}

fn search_map_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Читается ли файл как v2 (маркер в заголовке).
fn is_search_maps_v2(raw: &str) -> bool {
    raw.contains("# search-maps v2")
}

/// Канон мапы (v2-семантика) при любом формате файла — зеркало SearchMaps бэкенда.
#[derive(Debug, Default, Clone)]
struct SearchMapsCanon {
    /// сервер -> базы (последняя строка с тем же ключом побеждает)
    servers: Vec<(String, Vec<String>)>,
    /// строка '*'
    wildcard: Option<Vec<String>>,
    /// строки '!база' (явный запрет)
    blocked: Vec<String>,
}

/// Инвертировать v1 («база=серверы») в канон v2 в памяти: «база=» без серверов
/// превращается в блок-строку, упомянутые базы разъезжаются по строкам серверов.
fn v1_to_canon(entries: &[(String, Vec<String>)]) -> SearchMapsCanon {
    let mut canon = SearchMapsCanon::default();
    for (base, servers) in entries {
        for srv in servers {
            if let Some(row) = canon.servers.iter_mut().find(|e| &e.0 == srv) {
                if !row.1.contains(base) {
                    row.1.push(base.clone());
                }
            } else {
                canon.servers.push((srv.clone(), vec![base.clone()]));
            }
        }
        if servers.is_empty() && !canon.blocked.contains(base) {
            canon.blocked.push(base.clone());
        }
    }
    canon
}

/// Разобрать файл старого формата (v1: «база=серверы») — как раньше: чанки по ';',
/// строка начинается с '#' — пропуск, «база=» — валидный пустой список.
/// Последняя запись с тем же именем побеждает. Некорректные чанки — в warnings.
fn parse_search_maps_v1(raw: &str) -> (Vec<(String, Vec<String>)>, Vec<String>) {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for chunk in raw.split(';') {
        let chunk = chunk.trim();
        if chunk.is_empty() || chunk.starts_with('#') {
            continue;
        }
        match chunk.split_once('=') {
            Some((name, servers)) => {
                let name = name.trim().to_lowercase();
                if name.is_empty() || !search_map_name_ok(&name) {
                    let head: String = chunk.chars().take(40).collect();
                    warnings.push(format!(
                        "v1-запись с некорректным именем пропущена (начинается с {head:?})"
                    ));
                    continue;
                }
                let servers: Vec<String> = servers
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if let Some(e) = out.iter_mut().find(|e| e.0 == name) {
                    e.1 = servers;
                } else {
                    out.push((name, servers));
                }
            }
            None => {
                let head: String = chunk.chars().take(40).collect();
                warnings.push(format!("v1-запись без '=' пропущена: {head:?}"));
            }
        }
    }
    (out, warnings)
}

/// Список баз из значения строки v2: НРег, пустые чанки пропускаются.
fn parse_v2_bases(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Разобрать v2 («сервер=базы», '*' — прочие, '!база=' — явный запрет) —
/// зеркало parse_v2 бэкенда. Кривые чанки — в warnings (GET файл не роняет).
fn parse_search_maps_v2(raw: &str) -> (SearchMapsCanon, Vec<String>) {
    let mut canon = SearchMapsCanon::default();
    let mut warnings: Vec<String> = Vec::new();
    for chunk in raw.split(';') {
        let chunk = chunk.trim();
        if chunk.is_empty() || chunk.starts_with('#') {
            continue;
        }
        let Some((key, value)) = chunk.split_once('=') else {
            let head: String = chunk.chars().take(40).collect();
            warnings.push(format!("v2-запись без '=' пропущена: {head:?}"));
            continue;
        };
        let key = key.trim();
        let bases = parse_v2_bases(value);
        if key == "*" {
            canon.wildcard = Some(bases);
            continue;
        }
        if let Some(base) = key.strip_prefix('!') {
            let base = base.trim().to_lowercase();
            if !search_map_name_ok(&base) {
                let head: String = chunk.chars().take(40).collect();
                warnings.push(format!(
                    "v2-блок-строка с некорректным именем базы пропущена: {head:?}"
                ));
                continue;
            }
            if !bases.is_empty() {
                warnings.push(format!(
                    "v2-блок-строке !{base}= нельзя назначить серверы — серверы игнорируются"
                ));
            }
            if !canon.blocked.contains(&base) {
                canon.blocked.push(base);
            }
            continue;
        }
        let name = key.to_lowercase();
        if name.is_empty() || !search_map_name_ok(&name) {
            let head: String = chunk.chars().take(40).collect();
            warnings.push(format!(
                "v2-запись с некорректным ключом сервера пропущена: {head:?} — сохраните мапу из UI, чтобы файл был перезаписан канонично"
            ));
            continue;
        }
        if let Some(row) = canon.servers.iter_mut().find(|e| e.0 == name) {
            row.1 = bases;
        } else {
            canon.servers.push((name, bases));
        }
    }
    (canon, warnings)
}

/// Разобрать файл любого формата по маркеру: v2 сразу, v1 — с инверсией в памяти.
fn parse_search_maps_any(raw: &str) -> (SearchMapsCanon, &'static str, Vec<String>) {
    if is_search_maps_v2(raw) {
        let (canon, warnings) = parse_search_maps_v2(raw);
        (canon, "v2", warnings)
    } else {
        let (v1, mut warnings) = parse_search_maps_v1(raw);
        warnings.push(
            "файл старого формата (v1: база=серверы) — первое сохранение из UI или «Конвертировать» перепишет его в v2"
                .into(),
        );
        (v1_to_canon(&v1), "v1", warnings)
    }
}

/// Сериализовать канон (без заголовка): первая строка — технический ';' (отрезает
/// заголовок от первой записи), далее каждая запись на своей строке с хвостовым ';'.
/// '*' первой, затем серверы, затем блок-строки. У ЗАГОЛОВКА внутри ';' нет, значит
/// чанк до первого ';' — целиком заголовок ('#') и бэкенд пропускает его.
fn serialize_search_maps(m: &SearchMapsCanon) -> String {
    let mut rows: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(bases) = &m.wildcard {
        rows.push(("*".into(), bases.clone()));
    }
    rows.extend(m.servers.iter().cloned());
    for base in &m.blocked {
        rows.push((format!("!{base}"), Vec::new()));
    }
    let mut out = String::new();
    out.push(';');
    for (key, bases) in &rows {
        out.push('\n');
        out.push_str(key);
        out.push('=');
        out.push_str(&bases.join(","));
        out.push(';');
    }
    out
}

/// Записать файл мапы — строго in-place (как write_bases_conf): файл
/// bind-смонтирован в контейнер бэкенда ПО ФАЙЛУ, tmp+rename сменил бы inode,
/// и бэкенд продолжил бы читать старую копию до пересоздания контейнера.
fn write_search_maps(
    path: &std::path::Path,
    canon: &SearchMapsCanon,
) -> Result<(), axum::response::Response> {
    use axum::response::IntoResponse;
    let body = format!(
        "{SEARCH_MAPS_HEADER}\n{rows}",
        rows = serialize_search_maps(canon)
    );
    if let Err(e) = std::fs::write(path, body) {
        return Err(super::AppError::msg(format!("write search-maps.conf: {e}")).into_response());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct SearchMapServerRow {
    pub name: String,
    pub bases: Vec<String>,
}

/// GET /agent-backend/search-maps — мапа «сервер → базы» для UI.
/// v1-файл отдаётся в v2-каноне (in-memory инверсия) с format: "v1".
/// Битый файл не роняет GET: некорректные записи пропускаются с warning.
pub async fn search_maps_get(State(state): State<Arc<AppState>>) -> Json<Value> {
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = search_maps_conf_path(&root);
    let source = if path.is_file() { "file" } else { "absent" };
    let (canon, format, warnings) = if path.is_file() {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        parse_search_maps_any(&text)
    } else {
        (SearchMapsCanon::default(), "v2", Vec::new())
    };
    let servers: Vec<SearchMapServerRow> = canon
        .servers
        .iter()
        .map(|(name, bases)| SearchMapServerRow {
            name: name.clone(),
            bases: bases.clone(),
        })
        .collect();
    Json(json!({
        "source": source,
        "format": format,
        "servers": servers,
        "wildcard": canon.wildcard,
        "blocks": canon.blocked,
        "warnings": warnings,
    }))
}

#[derive(Debug, Deserialize)]
pub struct SearchMapPut {
    pub bases: Vec<String>,
}

/// Нормализовать список баз: НРег, пустые чанки — мимо, дубли — мимо.
/// Кривое имя — 400 (UI чипы обычно исключают опечатки, это последняя скважина).
fn normalize_bases(bases: Vec<String>) -> Result<Vec<String>, axum::response::Response> {
    use axum::response::IntoResponse;
    let mut out: Vec<String> = Vec::new();
    for b in bases {
        let b = b.trim().to_lowercase();
        if b.is_empty() {
            continue;
        }
        if !search_map_name_ok(&b) {
            return Err(super::BadRequest(format!(
                "некорректное имя базы {b:?} (латиница, цифры, _, -)"
            ))
            .into_response());
        }
        if !out.contains(&b) {
            out.push(b);
        }
    }
    Ok(out)
}

/// Прочитать канон текущего файла (absent — пустой канон).
fn read_search_maps_canon(path: &std::path::Path) -> SearchMapsCanon {
    if path.is_file() {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        parse_search_maps_any(&text).0
    } else {
        SearchMapsCanon::default()
    }
}

/// PUT /agent-backend/search-maps/{key} — создать/заменить строку.
/// Ключи: имя search-сервера, '*' (дефолт для прочих баз), '!база' (явный запрет,
/// список серверов у неё пуст по определению). Пустой список сервера валиден:
/// сервер на текущий момент никому не выдаётся.
pub async fn search_maps_put(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(key): axum::extract::Path<String>,
    Json(body): Json<SearchMapPut>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let key = key.trim().to_string();
    let bases = normalize_bases(body.bases)?;
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = search_maps_conf_path(&root);
    let mut canon = read_search_maps_canon(&path);
    if key == "*" {
        canon.wildcard = Some(bases.clone());
    } else if let Some(base) = key.strip_prefix('!') {
        let base = base.trim().to_lowercase();
        if !search_map_name_ok(&base) {
            return Err(super::BadRequest(
                "некорректное имя базы в блок-строке (латиница, цифры, _, -)".into(),
            )
            .into_response());
        }
        if !bases.is_empty() {
            return Err(
                super::BadRequest("блок-строке '!база=' нельзя назначить серверы".into())
                    .into_response(),
            );
        }
        if !canon.blocked.contains(&base) {
            canon.blocked.push(base.clone());
        }
    } else {
        let name = key.to_lowercase();
        if !search_map_name_ok(&name) {
            return Err(super::BadRequest(
                "некорректный ключ (сервер: латиница, цифры, _, -; '*' — прочие; '!база' — запрет)"
                    .into(),
            )
            .into_response());
        }
        if let Some(row) = canon.servers.iter_mut().find(|e| e.0 == name) {
            row.1 = bases.clone();
        } else {
            canon.servers.push((name.clone(), bases.clone()));
        }
    }
    write_search_maps(&path, &canon)?;
    tracing::info!(
        "agent-backend: search-maps.conf обновлён — ключ {key} ({} баз(ы), hot-reload ≤2с)",
        bases.len()
    );
    Ok(Json(json!({ "ok": true, "key": key, "bases": bases })))
}

/// DELETE /agent-backend/search-maps/{key} — удалить строку ('*', сервер, '!база').
/// Серверная строка: её базы переходят в «прочие» ('*' или без фильтрации).
/// Блок-строка: база снимает запрет и переходит в «прочие».
pub async fn search_maps_delete(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(key): axum::extract::Path<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let key = key.trim().to_string();
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = search_maps_conf_path(&root);
    if !path.is_file() {
        return Err(super::BadRequest(
            "search-maps.conf не найден — удалять нечего (базы и так без фильтрации)".into(),
        )
        .into_response());
    }
    let mut canon = read_search_maps_canon(&path);
    if key == "*" {
        if canon.wildcard.take().is_none() {
            return Err(
                super::BadRequest("строки '*' нет в search-maps.conf".into()).into_response(),
            );
        }
    } else if let Some(base) = key.strip_prefix('!') {
        let base = base.trim().to_lowercase();
        let before = canon.blocked.len();
        canon.blocked.retain(|b| *b != base);
        if canon.blocked.len() == before {
            return Err(super::BadRequest(format!(
                "блок-строка {base:?} не найдена в search-maps.conf"
            ))
            .into_response());
        }
    } else {
        let name = key.to_lowercase();
        let before = canon.servers.len();
        canon.servers.retain(|e| e.0 != name);
        if canon.servers.len() == before {
            return Err(
                super::BadRequest(format!("сервер {name:?} не найден в search-maps.conf"))
                    .into_response(),
            );
        }
    }
    write_search_maps(&path, &canon)?;
    tracing::info!("agent-backend: search-maps.conf — строка {key} удалена (hot-reload ≤2с)");
    Ok(Json(json!({ "ok": true, "key": key })))
}

/// POST /agent-backend/search-maps/convert — инвертировать v1-файл («база=серверы»)
/// в v2 («сервер=базы» + блок-строки) и перезаписать его. Для v2 — no-op (already).
pub async fn search_maps_convert(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = search_maps_conf_path(&root);
    if !path.is_file() {
        return Err(
            super::BadRequest("search-maps.conf не найден — конвертировать нечего".into())
                .into_response(),
        );
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    if is_search_maps_v2(&text) {
        return Ok(Json(json!({ "ok": true, "already": true, "format": "v2" })));
    }
    let (v1, _) = parse_search_maps_v1(&text);
    let canon = v1_to_canon(&v1);
    write_search_maps(&path, &canon)?;
    tracing::info!(
        "agent-backend: search-maps.conf конвертирован v1→v2 ({} сервер(ов), {} блок(ов))",
        canon.servers.len(),
        canon.blocked.len()
    );
    Ok(Json(json!({
        "ok": true,
        "servers": canon.servers.len(),
        "blocks": canon.blocked.len(),
    })))
}

// ─── stats (прокси к бэкенду /stats/*) ───

fn build_stats_url(base: &str, path: &str, qs: &HashMap<String, String>) -> String {
    let mut url = format!("{base}/stats/{path}");
    let params: Vec<String> = qs
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{}={}", urlencoding(k), urlencoding(v)))
        .collect();
    if !params.is_empty() {
        url.push_str(&format!("?{}", params.join("&")));
    }
    url
}

pub async fn stats_requests(
    State(state): State<Arc<AppState>>,
    Query(qs): Query<HashMap<String, String>>,
) -> Json<Value> {
    let url = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        build_stats_url(&backend_url(&db, &root), "requests", &qs)
    };
    match proxy_get(&url).await {
        Ok(v) => Json(json!({ "ok": true, "data": v })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

pub async fn stats_summary(
    State(state): State<Arc<AppState>>,
    Query(qs): Query<HashMap<String, String>>,
) -> Json<Value> {
    let url = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        build_stats_url(&backend_url(&db, &root), "summary", &qs)
    };
    match proxy_get(&url).await {
        Ok(v) => Json(json!({ "ok": true, "data": v })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

pub async fn stats_distinct(State(state): State<Arc<AppState>>) -> Json<Value> {
    let url = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        format!("{}/stats/distinct", backend_url(&db, &root))
    };
    match proxy_get(&url).await {
        Ok(v) => Json(json!({ "ok": true, "data": v })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

/// Прозрачный GET-прокси на эндпоинт бэкенда (path + query-string как есть).
async fn proxy_backend_path(
    state: &Arc<AppState>,
    path: &str,
    qs: &HashMap<String, String>,
) -> Json<Value> {
    let url = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        let mut url = format!("{}/{}", backend_url(&db, &root), path);
        let params: Vec<String> = qs
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| format!("{}={}", urlencoding(k), urlencoding(v)))
            .collect();
        if !params.is_empty() {
            url.push_str(&format!("?{}", params.join("&")));
        }
        url
    };
    match proxy_get(&url).await {
        Ok(v) => Json(json!({ "ok": true, "data": v })),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

pub async fn sessions_list(
    State(state): State<Arc<AppState>>,
    Query(qs): Query<HashMap<String, String>>,
) -> Json<Value> {
    proxy_backend_path(&state, "sessions", &qs).await
}

pub async fn session_messages(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<u64>,
    Query(qs): Query<HashMap<String, String>>,
) -> Json<Value> {
    proxy_backend_path(&state, &format!("sessions/{session_id}/messages"), &qs).await
}

pub async fn session_rounds(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<u64>,
    Query(qs): Query<HashMap<String, String>>,
) -> Json<Value> {
    proxy_backend_path(&state, &format!("sessions/{session_id}/rounds"), &qs).await
}

// ─── База знаний (RAG) ───
//
// Прокси к /rag/* бэкенда: состояние корпуса, список и просмотр документов,
// пробный поиск, переинжест. Без JWT — эндпоинты бэкенда читающие (закрытый
// контур, как остальные), а запись идёт через тот же локальный API.

/// POST/DELETE с телом — в отличие от proxy_get, ждёт ответа бэкенда и
/// отдаёт его как есть (ошибки бэкенда — с его кодом статуса).
async fn proxy_backend_send(
    state: &Arc<AppState>,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Json<Value> {
    let url = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        format!("{}/{}", backend_url(&db, &root), path)
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Json(json!({ "ok": false, "error": e.to_string() })),
    };
    let mut req = client.request(method, &url);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return Json(json!({ "ok": false, "error": format!("backend unreachable: {e}") }))
        }
    };
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => Json(v),
        Err(_) => Json(json!({
            "ok": false,
            "error": format!("backend returned {status}"),
            "detail": text.chars().take(500).collect::<String>(),
        })),
    }
}

/// GET к бэкенду — тело ответа как есть (без обёртки {ok,data}):
/// у RAG-эндпоинтов форма ответа уже содержит ok/ошибку.
async fn proxy_backend_raw(
    state: &Arc<AppState>,
    path: &str,
    qs: &HashMap<String, String>,
) -> Json<Value> {
    let url = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        let mut url = format!("{}/{}", backend_url(&db, &root), path);
        let params: Vec<String> = qs
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| format!("{}={}", urlencoding(k), urlencoding(v)))
            .collect();
        if !params.is_empty() {
            url.push_str(&format!("?{}", params.join("&")));
        }
        url
    };
    match proxy_get(&url).await {
        Ok(v) => Json(v),
        Err(e) => Json(json!({ "ok": false, "error": e })),
    }
}

pub async fn rag_status(State(state): State<Arc<AppState>>) -> Json<Value> {
    proxy_backend_raw(&state, "rag/status", &HashMap::new()).await
}

pub async fn rag_documents(
    State(state): State<Arc<AppState>>,
    Query(qs): Query<HashMap<String, String>>,
) -> Json<Value> {
    proxy_backend_raw(&state, "rag/documents", &qs).await
}

pub async fn rag_document(
    State(state): State<Arc<AppState>>,
    Path(document_id): Path<u64>,
) -> Json<Value> {
    proxy_backend_raw(
        &state,
        &format!("rag/documents/{document_id}"),
        &HashMap::new(),
    )
    .await
}

pub async fn rag_document_delete(
    State(state): State<Arc<AppState>>,
    Path(document_id): Path<u64>,
) -> Json<Value> {
    proxy_backend_send(
        &state,
        reqwest::Method::DELETE,
        &format!("rag/documents/{document_id}"),
        None,
    )
    .await
}

pub async fn rag_document_upload(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    proxy_backend_send(&state, reqwest::Method::POST, "rag/documents", Some(body)).await
}

pub async fn rag_search(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    proxy_backend_send(&state, reqwest::Method::POST, "rag/search", Some(body)).await
}

pub async fn rag_reingest(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    proxy_backend_send(&state, reqwest::Method::POST, "rag/reingest", Some(body)).await
}

pub async fn rag_collection_delete(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Json<Value> {
    proxy_backend_send(
        &state,
        reqwest::Method::DELETE,
        &format!("rag/collections/{}", urlencoding(&name)),
        None,
    )
    .await
}
