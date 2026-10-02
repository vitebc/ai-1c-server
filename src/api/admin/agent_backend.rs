//! Runtime control for the `1c-ai-agent` project: docker compose lifecycle,
//! service logs, `.env` config (allowlist), and live read-through of the
//! backend's own `GET /agents`, `GET /skills`, `GET /health`.
//!
//! Only `docker compose` is driven (no local uvicorn management).
//! Compose commands are an allowlist: `ps`, `up`, `stop`, `restart`, `logs`.
//! All commands run with `--project-directory <root>` and a timeout.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::collections::HashMap;

use axum::{
    extract::{Query, State},
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
    key.contains("PASSWORD") || key.contains("API_KEY") || key.contains("TOKEN") || key.contains("SECRET")
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
    // Prefer the project's own BACKEND_PORT from .env, default 8000.
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

async fn compose(
    root: &std::path::Path,
    args: &[&str],
) -> Result<(bool, String), String> {
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
                        health: v
                            .get("Health")
                            .and_then(|x| x.as_str())
                            .map(str::to_string),
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
        return Err(super::BadRequest("project root has no docker-compose.yml".into()).into_response());
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
    tracing::warn!("agent-backend: docker compose {action} services={:?}", body.services);
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
            && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')))
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
                        value: if secret { Some("***".into()) } else { Some(v.clone()) },
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
        return Err(super::BadRequest(format!("key {:?} is not editable", body.key)).into_response());
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
    tracing::warn!("agent-backend: .env key {} updated (restart backend to apply)", body.key);
    Ok(Json(json!({ "ok": true, "key": body.key, "restart_required": true })))
}

// ─── live read-through (backend's own view) ───

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

pub async fn live_agents(State(state): State<Arc<AppState>>) -> Json<Value> {
    let url = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        backend_url(&db, &root)
    };
    match proxy_get(&format!("{url}/agents")).await {
        Ok(v) => Json(json!({ "reachable": true, "data": v })),
        Err(e) => Json(json!({ "reachable": false, "error": e })),
    }
}

pub async fn live_skills(    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let url = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        backend_url(&db, &root)
    };
    let mut target = format!("{url}/skills");
    if let Some(a) = q.get("agent") {
        target.push_str(&format!("?agent={}", urlencoding(a)));
    }
    match proxy_get(&target).await {
        Ok(v) => Json(json!({ "reachable": true, "data": v })),
        Err(e) => Json(json!({ "reachable": false, "error": e })),
    }
}

/// GET /agent-backend/live/tools — full live ToolRegistry from the backend
/// (`GET /tools`: mock/live + local tools with descriptions).
/// The source of truth for `AGENT.md`/`SKILL.md` `tools:` selectors.
pub async fn live_tools(
    State(state): State<Arc<AppState>>,
    Query(qs): Query<HashMap<String, String>>,
) -> Json<Value> {
    let (url, base_url) = {
        let db = state.db.lock().await;
        let root = project_root(&db);
        let mut u = format!("{}/tools", backend_url(&db, &root));
        if let Some(b) = qs.get("base_url").filter(|b| !b.is_empty()) {
            u.push_str(&format!("?base_url={}", urlencoding(b)));
        }
        (u, qs.get("base_url").cloned().filter(|b| !b.is_empty()))
    };
    match proxy_get(&url).await {
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
fn parse_bases_lines(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for chunk in raw.split(';') {
        let chunk = chunk.trim().trim_matches('\r').trim_matches('\n');
        if chunk.is_empty() || chunk.starts_with('#') {
            continue;
        }
        if let Some((name, url)) = chunk.split_once('=') {
            let name = name.trim().to_lowercase();
            let url = url.trim();
            let name_ok = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if name_ok && (url.starts_with("http://") || url.starts_with("https://")) {
                out.push((name, url.to_string()));
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

const BASES_CONF_HEADER: &str = "# Мапа баз ONEC_BASES — hot-reload (перечитывается бэкендом по mtime, TTL 2с).\n\
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
        let entries = parse_bases_lines(&text);
        return Json(json!({ "source": "bases.conf", "bases": entries }));
    }

    // Fallback: ONEC_BASES из .env (стартовое значение бэкенда).
    let parsed = parse_dotenv(&root.join(".env"));
    let map: std::collections::HashMap<_, _> = parsed.into_iter().collect();
    let raw = map.get("ONEC_BASES").cloned().unwrap_or_default();
    Json(json!({ "source": "env", "bases": parse_bases_lines(&raw) }))
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
        return Err(super::BadRequest("backend/bases.conf не найден — создайте его из bases.conf.example".into()).into_response());
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
        return Err(super::BadRequest(format!("база {name:?} не найдена в bases.conf")).into_response());
    }
    write_bases_conf(&path, &entries)?;
    tracing::info!("agent-backend: база {name} отключена в bases.conf (hot-reload ≤2с)");
    Ok(Json(json!({ "ok": true, "name": name })))
}

fn write_bases_conf(path: &std::path::Path, entries: &[(String, String)]) -> Result<(), axum::response::Response> {
    use axum::response::IntoResponse;
    if let Err(e) = std::fs::write(path, format!("{BASES_CONF_HEADER}\n{serialized}\n", serialized = serialize_bases(entries))) {
        return Err(super::AppError::msg(format!("write bases.conf: {e}")).into_response());
    }
    Ok(())
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

pub async fn stats_distinct(
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
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
