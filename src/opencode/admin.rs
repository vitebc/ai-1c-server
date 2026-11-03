//! Admin API шлюза OpenCode: CRUD серверов, compose lifecycle, конфиги,
//! агенты/скилы (файлы в config/<server>), инструменты 1С (каталог + тест),
//! плагин, сессии, статус. Секция RBAC — `opencode`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path as AxPath, Query, State},
    http::StatusCode,
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::admin::{AppError, BadRequest, NotFound};
use crate::api::AppState;
use crate::opencode::{basic_auth, gateway_url, plugin_token, project_root};

// ─── rows / bodies ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ServerRow {
    pub id: String,
    pub name: String,
    pub title: String,
    pub config_dir: String,
    pub url: String,
    pub username: String,
    /// Пароль не отдаётся; только флаг.
    pub password_set: bool,
    pub bases: Vec<String>,
    pub compose_service: String,
    pub compose_profile: String,
    pub onec_user: String,
    pub onec_password_set: bool,
    pub enabled: bool,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ServerBody {
    pub name: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub config_dir: Option<String>,
    pub url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub bases: Option<Vec<String>>,
    #[serde(default)]
    pub compose_service: Option<String>,
    #[serde(default)]
    pub compose_profile: Option<String>,
    #[serde(default)]
    pub onec_user: Option<String>,
    #[serde(default)]
    pub onec_password: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub is_default: bool,
}

fn default_true() -> bool {
    true
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn read_row(db: &crate::db::Database, id: &str) -> Option<ServerRow> {
    db.conn
        .query_row(
            "SELECT id, name, title, config_dir, url, username, password, bases,
                    compose_service, compose_profile, onec_user, onec_password,
                    enabled, is_default, created_at, updated_at
             FROM opencode_servers WHERE id = ?1 OR name = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, i32>(12)? != 0,
                    row.get::<_, i32>(13)? != 0,
                    row.get::<_, String>(14)?,
                    row.get::<_, String>(15)?,
                ))
            },
        )
        .ok()
        .map(|(id, name, title, config_dir, url, username, pw, bases_raw, cs, cp, ou, opw, enabled, is_default, created_at, updated_at)| {
            ServerRow {
                id,
                name,
                title,
                config_dir,
                url,
                username,
                password_set: !pw.is_empty(),
            bases: serde_json::from_str(&bases_raw).unwrap_or_default(),
            compose_service: cs,
            compose_profile: cp,
            onec_user: ou,
            onec_password_set: !opw.is_empty(),
            enabled,
            is_default,
            created_at,
            updated_at,
            }
        })
}

/// Полная строка (с паролями) — только для внутреннего использования.
fn read_full(db: &crate::db::Database, id: &str) -> Option<(String, String, String, String)> {
    // (url, username, password, onec_password)
    db.conn
        .query_row(
            "SELECT url, username, password, onec_password FROM opencode_servers WHERE id = ?1 OR name = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .ok()
}

// ─── CRUD ───────────────────────────────────────────────────────────

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<ServerRow>> {
    let db = state.db.lock().await;
    let mut stmt = db
        .conn
        .prepare("SELECT id FROM opencode_servers ORDER BY name")
        .unwrap();
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .flatten()
        .collect();
    Json(ids.iter().filter_map(|id| read_row(&db, id)).collect())
}

pub async fn get_by_id(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<ServerRow>, axum::response::Response> {
    use axum::response::IntoResponse;
    let db = state.db.lock().await;
    match read_row(&db, &id) {
        Some(r) => Ok(Json(r)),
        None => Err(NotFound.into_response()),
    }
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ServerBody>,
) -> Result<Json<ServerRow>, axum::response::Response> {
    use axum::response::IntoResponse;
    if !valid_name(&body.name) {
        return Err(BadRequest(
            "name: ^[a-z0-9_-]+$ (max 64)".into(),
        )
        .into_response());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    // Конфиг-каталог: явный путь или <root>/config/<name>.
    let config_dir = body
        .config_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config").join(&body.name));
    // Существующий непустой каталог допустим — сервер «присоединяется»
    // к уже развёрнутому config/<server> (агенты/скилы/конфиг не трогаем).
    let db = state.db.lock().await;
    let exists: bool = db
        .conn
        .query_row(
            "SELECT 1 FROM opencode_servers WHERE name = ?1",
            [&body.name],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if exists {
        return Err(BadRequest(format!(
            "сервер {:#} уже существует",
            body.name
        ))
        .into_response());
    }
    db.conn
        .execute(
            "INSERT INTO opencode_servers (id, name, title, config_dir, url, username, password, bases, compose_service, compose_profile, onec_user, onec_password, enabled, is_default)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            rusqlite::params![
                id,
                body.name,
                body.title.unwrap_or_default(),
                config_dir.to_string_lossy().to_string(),
                body.url.trim_end_matches('/'),
                body.username.unwrap_or_else(|| "opencode".into()),
                body.password.clone().unwrap_or_default(),
                serde_json::to_string(&body.bases.clone().unwrap_or_default()).unwrap_or_else(|_| "[]".into()),
                body.compose_service.clone().unwrap_or_default(),
                body.compose_profile.clone().unwrap_or_default(),
                body.onec_user.clone().unwrap_or_default(),
                body.onec_password.clone().unwrap_or_default(),
                body.enabled as i32,
                body.is_default as i32,
            ],
        )
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    if body.is_default {
        let _ = db.conn.execute(
            "UPDATE opencode_servers SET is_default = 0 WHERE id != ?1",
            [&id],
        );
    }
    drop(db);
    // Подготовить каталог + раскидать плагин.
    let _ = std::fs::create_dir_all(&config_dir);
    deploy_plugin(&config_dir, &body.name).await;
    get_by_id(State(state), AxPath(id))
        .await
        .map_err(|_| AppError::msg("не удалось сохранить сервер").into_response())
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Json(body): Json<ServerBody>,
) -> Result<Json<ServerRow>, axum::response::Response> {
    use axum::response::IntoResponse;
    if !valid_name(&body.name) {
        return Err(BadRequest(
            "name: ^[a-z0-9_-]+$ (max 64)".into(),
        )
        .into_response());
    }
    let db = state.db.lock().await;
    let old = match read_row(&db, &id) {
        Some(r) => r,
        None => return Err(NotFound.into_response()),
    };
    // Незаданные опционалы = не менять (частичное обновление).
    let password = body.password.clone().unwrap_or_default();
    let onec_password = body.onec_password.clone().unwrap_or_default();
    let config_dir = match body.config_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => p.to_string(),
        None => old.config_dir,
    };
    let title = body.title.clone().unwrap_or_else(|| old.title.clone());
    let username = body.username.clone().unwrap_or_else(|| old.username.clone());
    let bases_raw = match &body.bases {
        Some(b) => serde_json::to_string(b).unwrap_or_else(|_| "[]".into()),
        None => serde_json::to_string(&old.bases).unwrap_or_else(|_| "[]".into()),
    };
    let compose_service = body.compose_service.clone().unwrap_or_else(|| old.compose_service.clone());
    let compose_profile = body.compose_profile.clone().unwrap_or_else(|| old.compose_profile.clone());
    let onec_user = body.onec_user.clone().unwrap_or_else(|| old.onec_user.clone());
    db.conn
        .execute(
            "UPDATE opencode_servers SET name = ?1, title = ?2, config_dir = ?3, url = ?4, username = ?5,
             bases = ?6, compose_service = ?7, compose_profile = ?8, onec_user = ?9, enabled = ?10, is_default = ?11,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?12",
            rusqlite::params![
                body.name,
                title,
                config_dir,
                body.url.trim_end_matches('/'),
                username,
                bases_raw,
                compose_service,
                compose_profile,
                onec_user,
                body.enabled as i32,
                body.is_default as i32,
                old.id,
            ],
        )
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    if !password.is_empty() {
        db.conn
            .execute("UPDATE opencode_servers SET password = ?1 WHERE id = ?2", [&password, &old.id])
            .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    }
    if !onec_password.is_empty() {
        db.conn
            .execute(
                "UPDATE opencode_servers SET onec_password = ?1 WHERE id = ?2",
                [&onec_password, &old.id],
            )
            .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    }
    if body.is_default {
        let _ = db.conn.execute(
            "UPDATE opencode_servers SET is_default = 0 WHERE id != ?1",
            [&old.id],
        );
    }
    drop(db);
    get_by_id(State(state), AxPath(old.id))
        .await
        .map_err(|_| AppError::msg("не удалось сохранить сервер").into_response())
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let db = state.db.lock().await;
    let changes = db
        .conn
        .execute("DELETE FROM opencode_servers WHERE id = ?1 OR name = ?1", [&id])
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    if changes == 0 {
        return Err(NotFound.into_response());
    }
    Ok(Json(json!({ "ok": true, "id": id })))
}

// ─── compose lifecycle / logs ───────────────────────────────────────

const CMD_TIMEOUT: Duration = Duration::from_secs(120);

async fn compose(root: &Path, args: &[&str]) -> Result<(bool, String), String> {
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

#[derive(Debug, Deserialize)]
pub struct LifecycleBody {
    pub server: String,
    #[serde(default)]
    pub action: Option<String>, // up | stop | restart (дефолт из пути)
}

async fn lifecycle(
    state: &Arc<AppState>,
    default_action: &str,
    body: LifecycleBody,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let action = body.action.clone().unwrap_or_else(|| default_action.into());
    if !matches!(action.as_str(), "up" | "stop" | "restart") {
        return Err(BadRequest("action: up|stop|restart".into()).into_response());
    }
    let (root, service, profile) = {
        let db = state.db.lock().await;
        let row = match read_row(&db, &body.server) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        };
        if row.compose_service.is_empty() {
            return Err(BadRequest(format!(
                "у сервера {} не задан compose-сервис",
                row.name
            ))
            .into_response());
        }
        (project_root(&db), row.compose_service.clone(), row.compose_profile)
    };
    if !root.join("docker-compose.yml").is_file() {
        return Err(BadRequest(format!(
            "нет docker-compose.yml в {}",
            root.display()
        ))
        .into_response());
    }
    let mut args: Vec<String> = vec![];
    if !profile.is_empty() {
        args.push("--profile".into());
        args.push(profile);
    }
    args.push(action.clone().into());
    args.push(service.clone());
    let (ok, text) = match compose(&root, &args.iter().map(|s| s.as_str()).collect::<Vec<_>>())
        .await
    {
        Ok(r) => r,
        Err(e) => return Err(AppError::msg(e.to_string()).into_response()),
    };
    if !ok {
        return Err((StatusCode::BAD_GATEWAY, text).into_response());
    }
    Ok(Json(json!({ "ok": true, "server": body.server, "action": action.clone(), "output": text })))
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

#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    pub server: String,
    #[serde(default)]
    pub tail: Option<usize>,
}

pub async fn logs(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LogsQuery>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let (root, service) = {
        let db = state.db.lock().await;
        let row = match read_row(&db, &q.server) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        };
        if row.compose_service.is_empty() {
            return Err(BadRequest(
                "у сервера не задан compose-сервис".into(),
            )
            .into_response());
        }
        (project_root(&db), row.compose_service)
    };
    let tail = q.tail.unwrap_or(200).clamp(1, 2000).to_string();
    let args = vec!["logs", "--tail", &tail, &service];
    match compose(&root, &args).await {
        Ok((_, text)) => Ok(Json(json!({ "server": q.server, "logs": text }))),
        Err(e) => Err(AppError::msg(e.to_string()).into_response()),
    }
}

// ─── конфиг (opencode.jsonc) ────────────────────────────────────────

fn config_file(config_dir: &Path) -> PathBuf {
    config_dir.join("opencode.jsonc")
}

pub async fn config_get(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let row = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        }
    };
    let path = config_file(Path::new(&row.config_dir));
    if !path.is_file() {
        return Ok(Json(json!({ "exists": false, "content": null })));
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    // Валидация JSONC: убрать комментарии и хвостовые запятые → serde_json.
    let stripped = strip_jsonc(&content);
    if let Err(e) = serde_json::from_str::<Value>(&stripped) {
        return Ok(Json(json!({ "exists": true, "content": content, "error": e.to_string() })));
    }
    Ok(Json(json!({ "exists": true, "content": content, "error": null })))
}

/// Минимальная очистка JSONC: строки сохраняются, `//` и `/* */` вне строк
/// вырезаются, хвостовые запятые перед `}`/`]` — тоже.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            // Строка: копируем как есть (с экранированием).
            out.push(c);
            i += 1;
            while i < chars.len() {
                let ch = chars[i];
                out.push(ch);
                if ch == '\\' && i + 1 < chars.len() {
                    out.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                i += 1;
                if ch == '"' {
                    break;
                }
            }
        } else if c == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if c == ',' {
            // Хвостовая запятая: дальше только пробелы до } или ].
            let rest = &chars[i + 1..];
            let next_significant = rest.iter().find(|c| !c.is_whitespace());
            if matches!(next_significant, Some('}') | Some(']')) {
                i += 1; // пропускаем запятую
            } else {
                out.push(c);
                i += 1;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

#[derive(Debug, Deserialize)]
pub struct ConfigBody {
    pub content: String,
}

pub async fn config_put(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Json(body): Json<ConfigBody>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let stripped = strip_jsonc(&body.content);
    if let Err(e) = serde_json::from_str::<Value>(&stripped) {
        return Err(BadRequest(format!("некорректный JSON: {e}")).into_response());
    }
    let row = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        }
    };
    let path = config_file(Path::new(&row.config_dir));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    }
    std::fs::write(&path, &body.content)
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    tracing::info!("opencode: config saved for {} ({})", row.name, path.display());
    Ok(Json(json!({ "ok": true, "path": path.to_string_lossy().to_string() })))
}

// ─── агенты и скилы (файлы в config/<server>) ──────────────────────

fn agents_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("agents")
}

fn skills_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("skills")
}

fn valid_skill_name(name: &str) -> bool {
    // ^[a-z0-9]+(-[a-z0-9]+)*$
    let mut parts = name.split('-');
    !name.is_empty()
        && name.len() <= 64
        && parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

fn parse_frontmatter(text: &str) -> (serde_yaml::Mapping, String) {
    let mut meta = serde_yaml::Mapping::new();
    let body = text.to_string();
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return (meta, body);
    }
    if let Some(end) = lines[1..].iter().position(|l| l.trim() == "---") {
        let fm_lines: Vec<&str> = lines[1..=end].to_vec();
        let rest_start = end + 2;
        let body = text.lines().skip(rest_start).collect::<Vec<_>>().join("\n");
        if let Ok(v) = serde_yaml::from_str::<serde_yaml::Value>(&fm_lines.join("\n")) {
            if let serde_yaml::Value::Mapping(m) = v {
                meta = m;
            }
        }
        return (meta, body);
    }
    (meta, body)
}

fn fm_str(meta: &serde_yaml::Mapping, key: &str) -> String {
    meta.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

pub async fn agents_list(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let row = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        }
    };
    let dir = agents_dir(Path::new(&row.config_dir));
    let mut agents: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            // Плоские файлы: agents/<имя>.md (frontmatter + Markdown).
            if !p.is_file() || p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let name = match p.file_stem().and_then(|n| n.to_str()).map(str::to_string) {
                Some(n) if !n.starts_with('.') => n,
                _ => continue,
            };
            let content = match std::fs::read_to_string(&p) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let (meta, body) = parse_frontmatter(&content);
            agents.push(json!({
                "name": name,
                "description": fm_str(&meta, "description"),
                "mode": fm_str(&meta, "mode"),
                "model": fm_str(&meta, "model"),
                "frontmatter": serde_yaml::to_string(&meta).unwrap_or_default(),
                "body": body,
            }));
        }
    }
    agents.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Ok(Json(json!({ "server": row.name, "dir": dir.to_string_lossy().to_string(), "agents": agents })))
}

#[derive(Debug, Deserialize)]
pub struct AgentFileBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub hidden: Option<bool>,
    pub body: String,
}

fn render_agent_file(body: &AgentFileBody) -> String {
    let mut fm = String::new();
    fm.push_str("---\n");
    if let Some(t) = &body.title {
        if !t.is_empty() {
            fm.push_str(&format!("title: {}\n", t.replace('"', "\\\"")));
        }
    }
    if let Some(d) = &body.description {
        if !d.is_empty() {
            fm.push_str(&format!("description: {}\n", d.replace('"', "\\\"")));
        }
    }
    if let Some(m) = &body.mode {
        if !m.is_empty() {
            fm.push_str(&format!("mode: {}\n", m));
        }
    }
    if body.hidden == Some(true) {
        fm.push_str("hidden: true\n");
    }
    fm.push_str("---\n\n");
    fm.push_str(body.body.trim_end());
    fm.push('\n');
    fm
}

pub async fn agent_put(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Json(body): Json<AgentFileBody>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let name = body.name.clone().unwrap_or_default();
    if !valid_name(&name) {
        return Err(BadRequest(
            "name: ^[a-z0-9_-]+$ (max 64)".into(),
        )
        .into_response());
    }
    let row = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        }
    };
    let dir = agents_dir(Path::new(&row.config_dir)).join(&name);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    let path = dir.join("AGENT.md");
    std::fs::write(&path, render_agent_file(&body))
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    tracing::info!("opencode: agent {} saved for {}", name, row.name);
    Ok(Json(json!({ "ok": true, "name": name, "path": path.to_string_lossy().to_string() })))
}

pub async fn agent_delete(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let name = q.get("name").cloned().unwrap_or_default();
    if !valid_name(&name) {
        return Err(BadRequest("invalid name".into()).into_response());
    }
    let row = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        }
    };
    let dir = agents_dir(Path::new(&row.config_dir)).join(&name);
    if !dir.is_dir() {
        return Err(NotFound.into_response());
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    Ok(Json(json!({ "ok": true, "name": name })))
}

pub async fn skills_list(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let row = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        }
    };
    let dir = skills_dir(Path::new(&row.config_dir));
    let mut skills: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if !p.is_dir() || p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(true) {
                continue;
            }
            let md = p.join("SKILL.md");
            if !md.is_file() {
                continue;
            }
            let content = match std::fs::read_to_string(&md) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let (meta, body) = parse_frontmatter(&content);
            skills.push(json!({
                "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                "description": fm_str(&meta, "description"),
                "body": body,
            }));
        }
    }
    skills.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Ok(Json(json!({ "server": row.name, "dir": dir.to_string_lossy().to_string(), "skills": skills })))
}

#[derive(Debug, Deserialize)]
pub struct SkillFileBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub body: String,
}

pub async fn skill_put(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Json(body): Json<SkillFileBody>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let name = body.name.clone().unwrap_or_default();
    if !valid_skill_name(&name) {
        return Err(BadRequest(
            "name: ^[a-z0-9]+(-[a-z0-9]+)*$ (max 64)".into(),
        )
        .into_response());
    }
    let row = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        }
    };
    let dir = skills_dir(Path::new(&row.config_dir)).join(&name);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    let mut fm = String::from("---\n");
    fm.push_str(&format!("name: {name}\n"));
    if let Some(d) = &body.description {
        if !d.is_empty() {
            fm.push_str(&format!("description: {}\n", d.replace('"', "\\\"")));
        }
    }
    fm.push_str("---\n\n");
    fm.push_str(body.body.trim_end());
    fm.push('\n');
    let path = dir.join("SKILL.md");
    std::fs::write(&path, &fm)
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    tracing::info!("opencode: skill {} saved for {}", name, row.name);
    Ok(Json(json!({ "ok": true, "name": name, "path": path.to_string_lossy().to_string() })))
}

pub async fn skill_delete(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let name = q.get("name").cloned().unwrap_or_default();
    if !valid_skill_name(&name) {
        return Err(BadRequest("invalid name".into()).into_response());
    }
    let row = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        }
    };
    let dir = skills_dir(Path::new(&row.config_dir)).join(&name);
    if !dir.is_dir() {
        return Err(NotFound.into_response());
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    Ok(Json(json!({ "ok": true, "name": name })))
}

// ─── инструменты 1С (каталог + тест) ───────────────────────────────

fn tools_catalog_path(config_dir: &Path) -> PathBuf {
    config_dir.join("plugins").join("1c-tools").join("catalog.json")
}

/// Basic-креды сервера для синхронизации каталога.
pub async fn tools_sync(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let (_config_dir, onec_user, onec_password) = {
        let db = state.db.lock().await;
        let row = match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        };
        let full = read_full(&db, &id);
        (row.config_dir, row.onec_user, full.map(|f| f.3).unwrap_or_default())
    };
    if onec_user.is_empty() || onec_password.is_empty() {
        return Err(BadRequest(
            "у сервера не заданы onec_user/onec_password (креды 1С для синхронизации)".into(),
        )
        .into_response());
    }
    // База: первая из bases, резолвим через мапу agent/bases.conf.
    let bases = {
        let db = state.db.lock().await;
        read_row(&db, &id).map(|r| r.bases).unwrap_or_default()
    };
    let base_url = resolve_base_url(&state, first_base(&bases).as_deref()).await;
    let rpc_url = match base_url {
        Some(u) => format!("{}/hs/mcp/rpc", u.trim_end_matches('/')),
        None => {
            return Err(BadRequest(
                "нет ни одной базы в bases, и её не удалось резолвить (bases.conf / .env)".into(),
            )
            .into_response())
        }
    };
    let payload = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    let resp = client
        .post(&rpc_url)
        .header("Content-Type", "application/json")
        .header("Authorization", basic_auth(&onec_user, &onec_password))
        .json(&payload)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("1С: {e}")).into_response())?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| (status, format!("1С: ответ не JSON: {e}")).into_response())?;
    if !status.is_success() || body.get("error").is_some() {
        return Err((
            status,
            format!("1С tools/list: {}", serde_json::to_string(&body).unwrap_or_default()),
        )
            .into_response());
    }
    let tools = body["result"]["tools"].clone();
    // Каталог рядом с плагином.
    let (path, token) = {
        let db = state.db.lock().await;
        let row = match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        };
        let secret = crate::auth::jwt_secret_pub(&db);
        (
            tools_catalog_path(Path::new(&row.config_dir)),
            plugin_token(&secret, &row.name),
        )
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    }
    // Токен плагина кладём рядом с каталогом: плагин шлёт его в X-OpenCode-Token.
    let mut catalog = json!({ "generated_at": chrono::Utc::now().to_rfc3339(), "tools": tools.clone() });
    catalog["gateway_token"] = json!(token);
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&catalog).unwrap_or_default(),
    )
    .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    let count = tools.as_array().map(|a| a.len()).unwrap_or(0);
    tracing::info!("opencode: tools catalog synced for {} ({} tools)", id, count);
    Ok(Json(json!({ "ok": true, "count": count, "path": path.to_string_lossy().to_string(), "token": token })))
}

fn first_base(bases: &[String]) -> Option<String> {
    bases.first().cloned()
}

/// Резолв имени базы → URL публикации через agent/bases.conf + ONEC_BASES из .env.
async fn resolve_base_url(state: &Arc<AppState>, base: Option<&str>) -> Option<String> {
    let base = base?.trim();
    if base.is_empty() {
        return None;
    }
    let root = {
        let db = state.db.lock().await;
        crate::api::admin::agent_files::project_root(&db)
    };
    // bases.conf: "имя=url;..."
    if let Ok(raw) = std::fs::read_to_string(root.join("backend").join("bases.conf")) {
        for (name, url) in crate::api::admin::agent_backend::parse_bases_lines_pub(&raw) {
            if name.eq_ignore_ascii_case(base) {
                return Some(url);
            }
        }
    }
    // ONEC_BASES из .env.
    let env_path = root.join(".env");
    if let Ok(text) = std::fs::read_to_string(&env_path) {
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

/// Тестовый вызов инструмента 1С под cred'ами сервера (без JWT — сервисный).
#[derive(Debug, Deserialize)]
pub struct ToolTestBody {
    pub tool: String,
    #[serde(default)]
    pub arguments: Option<Value>,
}

pub async fn tools_test(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
    Json(body): Json<ToolTestBody>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let (onec_user, onec_password, bases) = {
        let db = state.db.lock().await;
        let row = match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        };
        let full = read_full(&db, &id);
        (row.onec_user, full.map(|f| f.3).unwrap_or_default(), row.bases)
    };
    if onec_user.is_empty() || onec_password.is_empty() {
        return Err(BadRequest(
            "у сервера не заданы onec_user/onec_password".into(),
        )
        .into_response());
    }
    let base_url = resolve_base_url(&state, first_base(&bases).as_deref()).await;
    let rpc_url = match base_url {
        Some(u) => format!("{}/hs/mcp/rpc", u.trim_end_matches('/')),
        None => {
            return Err(BadRequest(
                "база не найдена в мапе (bases.conf / .env)".into(),
            )
            .into_response())
        }
    };
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": body.tool, "arguments": body.arguments.unwrap_or(json!({})) },
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    let started = std::time::Instant::now();
    let resp = client
        .post(&rpc_url)
        .header("Content-Type", "application/json")
        .header("Authorization", basic_auth(&onec_user, &onec_password))
        .json(&payload)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("1С: {e}")).into_response())?;
    let status = resp.status();
    let body: Value = resp
        .json()
        .await
        .map_err(|e| (status, format!("1С: ответ не JSON: {e}")).into_response())?;
    Ok(Json(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "result": body,
    })))
}

// ─── плагин 1c-tools ────────────────────────────────────────────────

/// Исходник плагина (единый для всех серверов).
pub const PLUGIN_SOURCE: &str = include_str!("../../opencode/plugin/1c-tools/index.ts");

fn plugin_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("plugins").join("1c-tools")
}

/// Раскладка плагина в конфиг-каталоге сервера.
pub async fn deploy_plugin(config_dir: &Path, _server_name: &str) {
    let dir = plugin_dir(config_dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join("index.ts"), PLUGIN_SOURCE);
}

pub async fn plugin_sync(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let row = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        }
    };
    deploy_plugin(Path::new(&row.config_dir), &row.name).await;
    Ok(Json(json!({ "ok": true, "path": plugin_dir(Path::new(&row.config_dir)).to_string_lossy().to_string() })))
}

/// Токен плагина сервера (для отладки/проверки).
pub async fn plugin_token_endpoint(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let db = state.db.lock().await;
    let row = match read_row(&db, &id) {
        Some(r) => r,
        None => return Err(NotFound.into_response()),
    };
    let secret = crate::auth::jwt_secret_pub(&db);
    Ok(Json(json!({ "token": plugin_token(&secret, &row.name) })))
}

// ─── сессии (реестр шлюза) ─────────────────────────────────────────

pub async fn sessions_list() -> Json<Value> {
    let entries = crate::opencode::gateway::sessions_snapshot();
    Json(json!({ "count": entries.len(), "sessions": entries }))
}

#[derive(Debug, Deserialize)]
pub struct SessionDropBody {
    pub session_id: String,
}

pub async fn session_drop(
    Json(body): Json<SessionDropBody>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let ok = crate::opencode::gateway::drop_session(&body.session_id);
    if !ok {
        return Err(NotFound.into_response());
    }
    Ok(Json(json!({ "ok": true, "session_id": body.session_id })))
}

// ─── статус ─────────────────────────────────────────────────────────

pub async fn status(State(state): State<Arc<AppState>>) -> Json<Value> {
    let (root, gw_url) = {
        let db = state.db.lock().await;
        (project_root(&db), gateway_url(&db))
    };
    // Живость каждого сервера: GET /global/health.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build();
    let rows: Vec<(String, String, String)> = {
        let db = state.db.lock().await;
        let mut stmt = db
            .conn
            .prepare("SELECT id, name, url FROM opencode_servers ORDER BY name")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .flatten()
            .collect()
    };
    let mut servers: Vec<Value> = Vec::new();
    for (id, name, url) in &rows {
        let healthy = match client.as_ref() {
            Ok(c) => c
                .get(format!("{url}/global/health"))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false),
            Err(_) => false,
        };
        servers.push(json!({ "id": id, "name": name, "url": url, "healthy": healthy }));
    }
    Json(json!({
        "project_root": root.to_string_lossy().to_string(),
        "gateway_url": gw_url,
        "port": super::gateway_port(),
        "servers": servers,
    }))
}

// ─── routes ─────────────────────────────────────────────────────────

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/servers", get(list).post(create))
        .route(
            "/servers/{id}",
            get(get_by_id).put(update).delete(delete),
        )
        .route("/servers/{id}/up", post(up))
        .route("/servers/{id}/stop", post(stop))
        .route("/servers/{id}/restart", post(restart))
        .route("/servers/{id}/logs", get(logs))
        .route(
            "/servers/{id}/config",
            get(config_get).put(config_put),
        )
        .route("/servers/{id}/agents", get(agents_list))
        .route("/servers/{id}/agents/{name}", put(agent_put).delete(agent_delete))
        .route("/servers/{id}/skills", get(skills_list))
        .route("/servers/{id}/skills/{name}", put(skill_put).delete(skill_delete))
        .route("/servers/{id}/tools/sync", post(tools_sync))
        .route("/servers/{id}/tools/test", post(tools_test))
        .route("/servers/{id}/plugin/sync", post(plugin_sync))
        .route("/servers/{id}/plugin/token", get(plugin_token_endpoint))
        .route("/sessions", get(sessions_list))
        .route("/sessions/drop", post(session_drop))
        .route("/status", get(status))
}
