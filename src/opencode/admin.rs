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
    /// Агенты, отдаваемые клиенту (GET /api/agent). Пусто = все.
    #[serde(default)]
    pub visible_agents: Vec<String>,
    /// Выгрузки code-index, назначенные серверу (алиасы). Пусто = без выгрузок.
    #[serde(default)]
    pub code_indexes: Vec<String>,
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
    /// Агенты, отдаваемые клиенту (GET /api/agent). Пусто = все.
    #[serde(default)]
    pub visible_agents: Option<Vec<String>>,
    /// Выгрузки code-index (алиасы). Пусто = без выгрузок.
    #[serde(default)]
    pub code_indexes: Option<Vec<String>>,
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

/// Публичная версия valid_name (используется шлюзом для проверки id агентов).
pub fn is_valid_agent_name(name: &str) -> bool {
    valid_name(name)
}

/// Парсинг YAML frontmatter из файла агента: (meta, body).
/// Тело — без обрамляющих ---; если frontmatter отсутствует — meta пуст.
pub fn parse_frontmatter_pub(text: &str) -> (serde_yaml::Mapping, String) {
    parse_frontmatter(text)
}

/// Каталог агентов для config_dir (публичный — шлюз читает title из файлов).
pub fn agents_dir_pub(config_dir: &Path) -> PathBuf {
    agents_dir(config_dir)
}

fn read_row(db: &crate::db::Database, id: &str) -> Option<ServerRow> {
    db.conn
        .query_row(
            "SELECT id, name, title, config_dir, url, username, password, bases,
                    compose_service, compose_profile, onec_user, onec_password,
                    enabled, is_default, visible_agents, code_indexes, created_at, updated_at
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
                    row.get::<_, String>(16)?,
                    row.get::<_, String>(17)?,
                ))
            },
        )
        .ok()
        .map(|(id, name, title, config_dir, url, username, pw, bases_raw, cs, cp, ou, opw, enabled, is_default, va_raw, ci_raw, created_at, updated_at)| {
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
            visible_agents: serde_json::from_str(&va_raw).unwrap_or_default(),
            code_indexes: serde_json::from_str(&ci_raw).unwrap_or_default(),
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
            "INSERT INTO opencode_servers (id, name, title, config_dir, url, username, password, bases, compose_service, compose_profile, onec_user, onec_password, enabled, is_default, visible_agents, code_indexes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                serde_json::to_string(&body.visible_agents.clone().unwrap_or_default()).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&body.code_indexes.clone().unwrap_or_default()).unwrap_or_else(|_| "[]".into()),
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
    // Подготовить каталог конфигурации.
    let _ = std::fs::create_dir_all(&config_dir);
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
    // visible_agents: None = не менять, Some([]) = сбросить (все агенты видны).
    let va_raw = match &body.visible_agents {
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "[]".into()),
        None => serde_json::to_string(&old.visible_agents).unwrap_or_else(|_| "[]".into()),
    };
    // code_indexes: None = не менять, Some([]) = сбросить (без выгрузок).
    let ci_raw = match &body.code_indexes {
        Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "[]".into()),
        None => serde_json::to_string(&old.code_indexes).unwrap_or_else(|_| "[]".into()),
    };
    db.conn
        .execute(
            "UPDATE opencode_servers SET name = ?1, title = ?2, config_dir = ?3, url = ?4, username = ?5,
             bases = ?6, compose_service = ?7, compose_profile = ?8, onec_user = ?9, enabled = ?10, is_default = ?11,
             visible_agents = ?12, code_indexes = ?13, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?14",
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
                va_raw,
                ci_raw,
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

pub async fn server_logs(
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
                "title": fm_str(&meta, "title"),
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
    /// Полный YAML frontmatter (описание, mode, model, permissions и т.д.).
    /// Сохраняется как есть — правки полей не теряют остальные ключи.
    #[serde(default)]
    pub frontmatter: String,
    pub body: String,
}

fn render_agent_file(body: &AgentFileBody) -> String {
    let fm = body.frontmatter.trim();
    if fm.is_empty() {
        return format!("{}\n", body.body.trim_end());
    }
    // frontmatter без обрамляющих --- (клиент может прислать и с ними).
    let inner = fm.trim_start_matches("---").trim_end_matches("---").trim();
    format!("---\n{}\n---\n\n{}\n", inner, body.body.trim_end())
}

pub async fn agent_put(
    State(state): State<Arc<AppState>>,
    AxPath((id, name)): AxPath<(String, String)>,
    Json(body): Json<AgentFileBody>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
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
    let dir = agents_dir(Path::new(&row.config_dir));
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    let path = dir.join(format!("{name}.md"));
    std::fs::write(&path, render_agent_file(&body))
        .map_err(|e| AppError::msg(e.to_string()).into_response())?;
    tracing::info!("opencode: agent {} saved for {}", name, row.name);
    Ok(Json(json!({ "ok": true, "name": name, "path": path.to_string_lossy().to_string() })))
}

pub async fn agent_delete(
    State(state): State<Arc<AppState>>,
    AxPath((id, name)): AxPath<(String, String)>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
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
    let path = agents_dir(Path::new(&row.config_dir)).join(format!("{name}.md"));
    if !path.is_file() {
        return Err(NotFound.into_response());
    }
    std::fs::remove_file(&path)
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
    AxPath((id, name)): AxPath<(String, String)>,
    Json(body): Json<SkillFileBody>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
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
    AxPath((id, name)): AxPath<(String, String)>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
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

// ─── генерация плагина тулзов 1С (config/<server>/plugins/1c-tools/index.ts) ─

/// Путь каталога плагинов OpenCode в конфиг-директории сервера.
fn plugins_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("plugins")
}

/// Генерация плагина 1c-tools (OpenCode v2 API: Plugin.define + ctx.tool.transform).
/// Каталог инструментов вшивается в index.ts литералом — без fs/fetch в setup,
/// чтобы активация не подвисала. Вызовы идут через шлюз /onec/rpc с
/// X-OpenCode-Token + sessionID; шлюз подставляет JWT пользователя 1С (RLS).
fn generate_plugin(
    config_dir: &Path,
    catalog_json: &str,
    server_name: &str,
    gateway_url: &str,
    plugin_token: &str,
    pepek: Option<&str>,
) -> Result<usize, String> {
    let dir = plugins_dir(config_dir).join("1c-tools");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("mkdir plugins/1c-tools: {e}"))?;

    let catalog: Value = serde_json::from_str(catalog_json)
        .map_err(|e| format!("parse catalog: {e}"))?;
    let tools = catalog["tools"].as_array().cloned().unwrap_or_default();

    let mut entries = Vec::new();
    for t in &tools {
        let name = match t.get("name").and_then(|v| v.as_str()) {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        let desc_owned = t.get("description").and_then(|v| v.as_str()).map(|s| s.to_string())
            .unwrap_or_else(|| format!("Инструмент 1С: {name}"));
        let schema = t.get("inputSchema").cloned().unwrap_or(Value::Null);
        entries.push(format!(
            "  {{ name: {}, description: {}, input: {} }}",
            serde_json::to_string(name).unwrap_or_default(),
            serde_json::to_string(&desc_owned).unwrap_or_default(),
            serde_json::to_string(&schema).unwrap_or_else(|_| "null".into()),
        ));
    }

    let src = format!(
        r#"// Плагин 1c-tools (OpenCode v2): инструменты базы {server} как нативные тулзы.
// Сгенерировано админкой ai-1c-server — не редактировать вручную: кнопка
// «Сгенерировать плагин» перезапишет файл. Вызовы идут через шлюз /onec/rpc,
// который подставляет JWT пользователя 1С из реестра сессий (per-user RLS).
import {{ Plugin }} from "@opencode/plugin";

const GATEWAY = {gateway_url_json};
const TOKEN = {token_json};
// PEPK-токен: пароль шлюза (X-Onec-Pepek) — доверенный канал контейнера.
// Пусто, если пароль шлюза не задан.
const PEPK = {pepek_json};

const CATALOG: Array<{{ name: string; description: string; input: any }}> = [
{entries}
];

function rpcText(v: any): string {{
  if (v == null) return "(пустой ответ)";
  if (typeof v === "string") return v;
  const c = v?.result?.content;
  if (Array.isArray(c)) {{
    return c.map((b: any) => (b && typeof b.text === "string" ? b.text : JSON.stringify(b))).join("\n");
  }}
  if (v.error) return `ОШИБКА 1С: ${{JSON.stringify(v.error)}}`;
  return JSON.stringify(v);
}}

export default Plugin.define({{
  id: "onec-tools",
  async setup(ctx) {{
    await ctx.tool.transform((editor) => {{
      editor.namespace({{ name: "onec", description: `Инструменты 1С, база {server}` }});
      for (const t of CATALOG) {{
        editor.add({{
          name: t.name,
          description: t.description,
          input: t.input ?? {{ type: "object", properties: {{}} }},
          options: {{ namespace: "onec", codemode: false }},
          execute: async (input: any, context: any) => {{
            try {{
              const headers: Record<string, string> = {{ "Content-Type": "application/json", "X-OpenCode-Token": TOKEN }};
              if (PEPK) headers["X-Onec-Pepek"] = PEPK;
              const r = await fetch(GATEWAY + "/onec/rpc", {{
                method: "POST",
                headers,
                body: JSON.stringify({{ session_id: context.sessionID, params: {{ name: t.name, arguments: input }} }}),
                signal: context.signal,
              }});
              const v = await r.json().catch(() => null);
              if (!r.ok) return {{ content: `ОШИБКА шлюза ${{r.status}}: ${{v?.error ?? JSON.stringify(v)}}`, metadata: {{ error: true }} }};
              return {{ content: rpcText(v) }};
            }} catch (e: any) {{
              if (context?.signal?.aborted || e?.name === "AbortError") return {{ content: "ОТМЕНЕНО пользователем" }};
              return {{ content: `ОШИБКА вызова 1С: ${{String(e?.message || e)}}`, metadata: {{ error: true }} }};
            }}
          }},
        }});
      }}
    }});
  }},
}});
"#,
        server = server_name,
        gateway_url_json = serde_json::to_string(gateway_url).unwrap_or_default(),
        token_json = serde_json::to_string(plugin_token).unwrap_or_default(),
        pepek_json = serde_json::to_string(pepek.unwrap_or("")).unwrap_or_default(),
        entries = entries.join(",\n"),
    );

    std::fs::write(dir.join("index.ts"), src)
        .map_err(|e| format!("write index.ts: {e}"))?;

    // package.json в конфиг-директории: зависимость @opencode/plugin.
    let pkg_path = config_dir.join("package.json");
    let mut pkg: Value = std::fs::read_to_string(&pkg_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({ "name": format!("opencode-config-{server_name}"), "private": true }));
    let deps = pkg
        .get_mut("dependencies")
        .and_then(|d| d.as_object_mut())
        .map(|d| {
            d.insert("@opencode/plugin".into(), json!("2.1.4"));
            d.remove("@opencode-ai/plugin");
            true
        })
        .unwrap_or(false);
    if !deps {
        pkg["dependencies"] = json!({ "@opencode/plugin": "2.1.4" });
    }
    std::fs::write(&pkg_path, serde_json::to_string_pretty(&pkg).unwrap_or_default())
        .map_err(|e| format!("write package.json: {e}"))?;

    Ok(entries.len())
}

pub async fn tools_generate(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let (config_dir, catalog_path, name, gateway_url, token, pepek) = {
        let db = state.db.lock().await;
        let row = match read_row(&db, &id) {
            Some(r) => r,
            None => return Err(NotFound.into_response()),
        };
        let secret = crate::auth::jwt_secret_pub(&db);
        (
            row.config_dir.clone(),
            tools_catalog_path(Path::new(&row.config_dir)),
            row.name.clone(),
            crate::opencode::gateway_url(&db),
            crate::opencode::plugin_token(&secret, &row.name),
            crate::opencode::gateway_password(&db),
        )
    };
    let catalog_json = std::fs::read_to_string(&catalog_path)
        .map_err(|e| AppError::msg(format!("каталог не найден: {e}")).into_response())?;
    let config_dir = Path::new(&config_dir);
    match generate_plugin(config_dir, &catalog_json, &name, &gateway_url, &token, pepek.as_deref()) {
        Ok(count) => Ok(Json(json!({
            "ok": true,
            "count": count,
            "dir": plugins_dir(config_dir).join("1c-tools").to_string_lossy().to_string(),
            // Для проверки устаревания плагина в tools_apply.
            "gateway": gateway_url.clone(),
            "token": token.clone(),
        }))),
        Err(e) => Err(AppError::msg(e).into_response()),
    }
}

/// Одна кнопка: sync (1С → catalog.json) + generate (index.ts) + restart контейнера.
/// Если каталог не менялся — рестарт пропускаем (флаг restarted=false).
pub async fn tools_apply(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;

    // 1. Каталог до синхронизации (для сравнения).
    let catalog_path = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => tools_catalog_path(Path::new(&r.config_dir)),
            None => return Err(NotFound.into_response()),
        }
    };
    let old_tools: Option<Vec<Value>> = std::fs::read_to_string(&catalog_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["tools"].as_array().cloned());

    // 2. Sync: 1С → catalog.json (пишет сам).
    let sync_resp = tools_sync(State(state.clone()), AxPath(id.clone())).await;
    let sync_val = match sync_resp {
        Ok(Json(v)) => v,
        Err(r) => return Err(r),
    };

    // 3. Generate: catalog.json → plugins/1c-tools/index.ts.
    let gen_resp = tools_generate(State(state.clone()), AxPath(id.clone())).await;
    let gen_val = match gen_resp {
        Ok(Json(v)) => v,
        Err(r) => return Err(r),
    };

    // 4. Рестарт контейнера — только если каталог реально изменился ИЛИ плагин
    // не перегенерирован с актуальными константами (PEPK/GATEWAY/TOKEN).
    let new_tools: Vec<Value> = std::fs::read_to_string(&catalog_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["tools"].as_array().cloned())
        .unwrap_or_default();
    let catalog_changed = match &old_tools {
        None => true, // каталога не было — считаем изменённым
        Some(old) => old.len() != new_tools.len()
            || old.iter().zip(new_tools.iter()).any(|(a, b)| a["name"] != b["name"]),
    };
    let plugin_file = catalog_path.parent().map(|p| p.join("plugins/1c-tools/index.ts"));
    let plugin_stale = match &plugin_file {
        Some(p) if p.is_file() => {
            // Плагин устарел, если нет маркера текущей генерации. Маркер — строка
            // с PEPK-константой (появилась в версии с PEPK) и/или GATEWAY/TOKEN.
            let src = std::fs::read_to_string(p).unwrap_or_default();
            let has_pepek = src.contains("const PEPK");
            let gateway_now = gen_val.get("gateway").and_then(|v| v.as_str()).unwrap_or_default();
            let token_now = gen_val.get("token").and_then(|v| v.as_str()).unwrap_or_default();
            let has_gateway = if gateway_now.is_empty() { true } else { src.contains(&format!("const GATEWAY = \"{}\"", gateway_now)) };
            let has_token = if token_now.is_empty() { true } else { src.contains(&format!("const TOKEN = \"{}\"", token_now)) };
            !(has_pepek && has_gateway && has_token)
        }
        _ => false, // файла нет — рестарт не поможет, сгенерировали только что
    };
    let changed = catalog_changed || plugin_stale;
    let mut restarted = false;
    if changed {
        let row = {
            let db = state.db.lock().await;
            read_row(&db, &id)
        };
        match row {
            Some(r) if !r.compose_service.is_empty() => {
                let root = {
                    let db = state.db.lock().await;
                    project_root(&db)
                };
                if root.join("docker-compose.yml").is_file() {
                    // Имя сервиса в compose может отличаться от поля (например,
                    // server-ka2 против ka2) — пробовали точное имя и префикс.
                    let service = r.compose_service.as_str();
                    let candidates: Vec<String> = if service.is_empty() {
                        vec![]
                    } else {
                        let mut v = vec![service.to_string()];
                        for prefix in ["server-", "opencode-"] {
                            let c = format!("{prefix}{service}");
                            if !v.contains(&c) {
                                v.push(c);
                            }
                        }
                        v
                    };
                    let mut tried: Vec<String> = vec![];
                    for svc in candidates {
                        let (ok, text) = compose(
                            &root,
                            &["restart", svc.as_str()],
                        )
                        .await
                        .map_err(|e| AppError::msg(e).into_response())?;
                        tried.push(format!("{svc}: ok={ok}"));
                        if ok {
                            restarted = true;
                            break;
                        }
                    }
                    if !restarted && !tried.is_empty() {
                        return Err(AppError::msg(format!(
                            "docker compose restart не удался: {}",
                            tried.join("; ")
                        ))
                        .into_response());
                    }
                }
            }
            _ => {} // без compose-сервиса — рестарт не делаем (плагин подхватится при следующем старте)
        }
    }

    Ok(Json(json!({
        "ok": true,
        "synced": sync_val["count"],
        "generated": gen_val["count"],
        "changed": changed,
        "restarted": restarted,
        "dir": gen_val["dir"],
    })))
}

/// Установка зависимостей плагина (@opencode/plugin) в node_modules конфиг-директории.
pub async fn tools_install_deps(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let config_dir = {
        let db = state.db.lock().await;
        match read_row(&db, &id) {
            Some(r) => r.config_dir.clone(),
            None => return Err(NotFound.into_response()),
        }
    };
    let dir = Path::new(&config_dir);
    if !dir.join("node_modules/@opencode/plugin").exists() {
        let out = match tokio::time::timeout(
            std::time::Duration::from_secs(300),
            tokio::process::Command::new("npm")
                .arg("install")
                .args(["--no-audit", "--no-fund"])
                .current_dir(dir)
                .output(),
        )
        .await
        {
            Ok(out) => out.map_err(|e| AppError::msg(format!("npm install: {e}"))),
            Err(_) => return Err(AppError::msg("npm install: таймаут 300с").into_response()),
        };
        let out = match out {
            Ok(o) => o,
            Err(e) => return Err(e.into_response()),
        };
        if !out.status.success() {
            return Err(AppError::msg(format!(
                "npm install: {}",
                String::from_utf8_lossy(&out.stderr).chars().take(400).collect::<String>()
            ))
            .into_response());
        }
    }
    Ok(Json(json!({ "ok": true, "dir": dir.join("node_modules").to_string_lossy().to_string() })))
}

/// Токен тулзов сервера (для отладки/проверки).
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

// ─── токен Витра AI (анонимный режим) ───────────────────────────────

#[derive(Debug, Serialize)]
pub struct VitraTokenStatus {
    pub token_set: bool,
}

#[derive(Debug, Deserialize)]
pub struct VitraTokenBody {
    /// Пустая строка — очистить токен (выключить анонимный допуск).
    pub token: String,
}

/// GET /api/admin/opencode/vitra/token — только флаг, сам токен не отдаётся.
pub async fn vitra_token_get(State(state): State<Arc<AppState>>) -> Json<VitraTokenStatus> {
    let db = state.db.lock().await;
    Json(VitraTokenStatus {
        token_set: crate::opencode::vitra_token(&db).is_some(),
    })
}

/// PUT /api/admin/opencode/vitra/token — сохранить/очистить токен.
pub async fn vitra_token_put(
    State(state): State<Arc<AppState>>,
    Json(body): Json<VitraTokenBody>,
) -> Result<Json<VitraTokenStatus>, axum::response::Response> {
    use axum::response::IntoResponse;
    let token = body.token.trim().to_string();
    if token.len() > 256 {
        return Err(BadRequest("токен слишком длинный (макс 256)".into()).into_response());
    }
    let db = state.db.lock().await;
    if let Err(e) = db.conn.execute(
        "INSERT INTO server_settings (key, value) VALUES ('vitra_ai_token', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![token],
    ) {
        return Err(AppError::msg(format!("db: {e}")).into_response());
    }
    Ok(Json(VitraTokenStatus { token_set: !token.is_empty() }))
}

// ─── логи обращений к шлюзу ──────────────────────────────────────────

/// GET /api/admin/opencode/logs?limit= — обращения к шлюзу :9020 из общего
/// кольцевого буфера логов (target ai_1c_server::opencode).
pub async fn logs(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<Vec<crate::log_buffer::LogEntry>> {
    let limit: usize = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(300);
    Json(state.logs.entries(None, limit, None, Some("ai_1c_server::opencode")))
}

// ─── статистика запросов (opencode_requests) ────────────────────────

/// GET /api/admin/opencode/stats?from=&to=&client=&base= — список промптов
/// и сводка (по клиентам 1С/Витра, по базам, по серверам). Период — ISO UTC
/// (ts в таблице хранится в том же формате, строковое сравнение корректно).
pub async fn stats(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let from = q.get("from").cloned().filter(|v| !v.is_empty());
    let to = q.get("to").cloned().filter(|v| !v.is_empty());
    let client = q.get("client").cloned().filter(|v| !v.is_empty() && v != "all");
    let base = q.get("base").cloned().filter(|v| !v.is_empty());
    let limit: usize = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50).clamp(1, 500);
    let offset: usize = q.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);

    // WHERE-условия (строковые — ts ISO UTC сортируется лексикографически).
    let mut where_clauses: Vec<String> = Vec::new();
    let mut params: Vec<String> = Vec::new();
    if let Some(v) = &from {
        where_clauses.push(format!("ts >= ?{}", params.len() + 1));
        params.push(v.clone());
    }
    if let Some(v) = &to {
        where_clauses.push(format!("ts <= ?{}", params.len() + 1));
        params.push(v.clone());
    }
    if let Some(v) = &client {
        where_clauses.push(format!("client = ?{}", params.len() + 1));
        params.push(v.clone());
    }
    if let Some(v) = &base {
        where_clauses.push(format!("base = ?{}", params.len() + 1));
        params.push(v.clone());
    }
    let where_sql = if where_clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", where_clauses.join(" AND "))
    };

    let data = {
        let db = state.db.lock().await;
        let mut total: i64 = 0;
        let mut by_client: Vec<(String, i64)> = Vec::new();
        let mut by_base: Vec<(String, i64)> = Vec::new();
        let mut by_server: Vec<(String, i64)> = Vec::new();
        let mut items: Vec<Value> = Vec::new();

        let str_params: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();

        {
            let sql = format!("SELECT COUNT(*) FROM opencode_requests{where_sql}");
            if let Ok(mut s) = db.conn.prepare(&sql) {
                total = s.query_row(str_params.as_slice(), |r| r.get(0)).unwrap_or(0);
            }
        }

        let group = |table_col: &str, out: &mut Vec<(String, i64)>| {
            let sql = format!(
                "SELECT COALESCE({table_col}, ''), COUNT(*) FROM opencode_requests{where_sql} \
                 GROUP BY COALESCE({table_col}, '') ORDER BY COUNT(*) DESC LIMIT 50"
            );
            if let Ok(mut s) = db.conn.prepare(&sql) {
                if let Ok(rows) = s.query_map(str_params.as_slice(), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
                    for row in rows.flatten() {
                        out.push(row);
                    }
                }
            }
        };

        let mut by_agent: Vec<(String, i64)> = Vec::new();
        group("client", &mut by_client);
        group("base", &mut by_base);
        group("server", &mut by_server);
        group("agent", &mut by_agent);

        // Суммарные токены за период (по заполненным строкам).
        let mut tokens_in_total: i64 = 0;
        let mut tokens_out_total: i64 = 0;
        {
            let sql = format!(
                "SELECT COALESCE(SUM(tokens_in), 0), COALESCE(SUM(tokens_out), 0) FROM opencode_requests{where_sql}"
            );
            if let Ok(mut s) = db.conn.prepare(&sql) {
                if let Ok((a, b)) = s.query_row(str_params.as_slice(), |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))) {
                    tokens_in_total = a;
                    tokens_out_total = b;
                }
            }
        }

        let sql = format!(
            "SELECT id, ts, client, user_id, base, server, path, status, prompt, agent, tokens_in, tokens_out, duration_ms \
             FROM opencode_requests{where_sql} ORDER BY ts DESC, id DESC LIMIT ?{} OFFSET ?{}",
            params.len() + 1,
            params.len() + 2
        );
        if let Ok(mut s) = db.conn.prepare(&sql) {
            let limit_i = limit as i64;
            let offset_i = offset as i64;
            let all_params: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p as &dyn rusqlite::ToSql)
                .chain(std::iter::once(&limit_i as &dyn rusqlite::ToSql))
                .chain(std::iter::once(&offset_i as &dyn rusqlite::ToSql))
                .collect();
            if let Ok(rows) = s.query_map(all_params.as_slice(), |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "ts": r.get::<_, String>(1)?,
                    "client": r.get::<_, String>(2)?,
                    "user_id": r.get::<_, Option<String>>(3)?,
                    "base": r.get::<_, Option<String>>(4)?,
                    "server": r.get::<_, String>(5)?,
                    "path": r.get::<_, String>(6)?,
                    "status": r.get::<_, i32>(7)?,
                    "prompt": r.get::<_, Option<String>>(8)?,
                    "agent": r.get::<_, Option<String>>(9)?,
                    "tokens_in": r.get::<_, Option<i64>>(10)?,
                    "tokens_out": r.get::<_, Option<i64>>(11)?,
                    "duration_ms": r.get::<_, Option<i64>>(12)?,
                }))
            }) {
                for row in rows.flatten() {
                    items.push(row);
                }
            }
        }

        json!({
            "total": total,
            "items": items,
            "by_client": by_client.into_iter().map(|(k, v)| json!({"key": k, "count": v})).collect::<Vec<_>>(),
            "by_base": by_base.into_iter().map(|(k, v)| json!({"key": k, "count": v})).collect::<Vec<_>>(),
            "by_server": by_server.into_iter().map(|(k, v)| json!({"key": k, "count": v})).collect::<Vec<_>>(),
            "by_agent": by_agent.into_iter().map(|(k, v)| json!({"key": k, "count": v})).collect::<Vec<_>>(),
            "tokens_in_total": tokens_in_total,
            "tokens_out_total": tokens_out_total,
        })
    };

    Json(json!({ "ok": true, "data": data }))
}

// ─── статус ─────────────────────────────────────────────────────────

pub async fn status(State(state): State<Arc<AppState>>) -> Json<Value> {
    let (root, gw_url, port) = {
        let db = state.db.lock().await;
        (project_root(&db), gateway_url(&db), super::gateway_port())
    };
    let alive = super::gateway_alive(port).await;
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
        let config_dir = {
            let db = state.db.lock().await;
            read_row(&db, id).map(|r| r.config_dir.clone()).unwrap_or_default()
        };
        let cfg_path = Path::new(&config_dir);
        servers.push(json!({
            "id": id,
            "name": name,
            "url": url,
            "healthy": healthy,
            "plugin_generated": cfg_path.join("plugins/1c-tools/index.ts").exists(),
            "deps_installed": cfg_path.join("node_modules/@opencode/plugin").exists(),
        }));
    }
    let (password_set, session_count) = {
        let db = state.db.lock().await;
        let pw = crate::opencode::gateway_password(&db).is_some();
        (pw, super::gateway::sessions_snapshot().len())
    };
    Json(json!({
        "project_root": root.to_string_lossy().to_string(),
        "gateway_url": gw_url,
        "port": port,
        "alive": alive,
        "password_set": password_set,
        "session_count": session_count,
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
        .route("/servers/{id}/logs", get(server_logs))
        .route(
            "/servers/{id}/config",
            get(config_get).put(config_put),
        )
        .route("/servers/{id}/agents", get(agents_list))
        .route("/servers/{id}/agents/{name}", put(agent_put))
        .route("/servers/{id}/agents/{name}", axum::routing::delete(agent_delete))
        .route("/servers/{id}/skills", get(skills_list))
        .route("/servers/{id}/skills/{name}", put(skill_put))
        .route("/servers/{id}/skills/{name}", axum::routing::delete(skill_delete))
        .route("/servers/{id}/tools/sync", post(tools_sync))
        .route("/servers/{id}/tools/generate", post(tools_generate))
        .route("/servers/{id}/tools/apply", post(tools_apply))
        .route("/servers/{id}/tools/install-deps", post(tools_install_deps))
        .route("/servers/{id}/tools/test", post(tools_test))
        .route("/servers/{id}/plugin/token", get(plugin_token_endpoint))
        .route("/sessions", get(sessions_list))
        .route("/sessions/drop", post(session_drop))
        .route("/vitra/token", get(vitra_token_get).put(vitra_token_put))
        .route("/logs", get(logs))
        .route("/stats", get(stats))
        .route("/status", get(status))
}
