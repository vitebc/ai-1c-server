//! User management (admin only — enforced by the RBAC section map).
//! Passwords: argon2, min 8 chars. Reset returns plaintext **once**.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Extension, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::super::AppState;
use crate::auth;

/// Caller may see/touch admin accounts: legacy token or admin role.
fn is_admin_ident(ident: &auth::AuthIdentity) -> bool {
    ident.system || ident.role == auth::ROLE_ADMIN
}

fn forbidden_admin() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "admin role required" })),
    )
        .into_response()
}

#[derive(Debug, Serialize)]
pub struct UserDto {
    pub id: String,
    pub username: String,
    pub role: String,
    pub sections: Option<serde_json::Value>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_dto(
    id: String,
    username: String,
    role: String,
    sections: Option<String>,
    enabled: bool,
    created_at: String,
    updated_at: String,
) -> UserDto {
    UserDto {
        id,
        username,
        role,
        sections: sections.and_then(|s| serde_json::from_str(&s).ok()),
        enabled,
        created_at,
        updated_at,
    }
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Extension(ident): Extension<auth::AuthIdentity>,
) -> Json<Vec<UserDto>> {
    let db = state.db.lock().await;
    let mut stmt = db
        .conn
        .prepare(
            "SELECT id, username, role, sections, enabled, created_at, updated_at
             FROM users ORDER BY username",
        )
        .unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok(row_to_dto(
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get::<_, i32>(4)? != 0,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .unwrap();
    Json(
        rows
            .flatten()
            // Non-admins never see admin accounts (usernames stay hidden too).
            .filter(|u| is_admin_ident(&ident) || u.role != "admin")
            .collect(),
    )
}

#[derive(Debug, Deserialize)]
pub struct CreateUser {
    pub username: String,
    pub password: String,
    #[serde(default = "default_role")]
    pub role: String,
}

fn default_role() -> String {
    auth::ROLE_VIEWER.into()
}

fn valid_role(role: &str) -> bool {
    matches!(
        role,
        auth::ROLE_ADMIN | auth::ROLE_OPERATOR | auth::ROLE_VIEWER | auth::ROLE_PROMPTER
    )
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Extension(ident): Extension<auth::AuthIdentity>,
    Json(body): Json<CreateUser>,
) -> Response {
    let username = body.username.trim().to_string();
    if !auth::is_valid_username(&username) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "username must be 3..32 chars: a-z 0-9 _ . -" })),
        )
            .into_response();
    }
    if body.password.len() < 8 || body.password.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "password must be 8..128 chars" })),
        )
            .into_response();
    }
    if !valid_role(&body.role) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "role must be admin|operator|viewer|prompter" })),
        )
            .into_response();
    }
    if body.role == "admin" && !is_admin_ident(&ident) {
        return forbidden_admin();
    }
    let hash = match auth::hash_password(&body.password) {
        Ok(h) => h,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e })),
            )
                .into_response()
        }
    };
    let id = uuid::Uuid::new_v4().to_string();
    let db = state.db.lock().await;
    if let Err(e) = db.conn.execute(
        "INSERT INTO users (id, username, password_hash, role) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, username, hash, body.role],
    ) {
        let msg = e.to_string();
        if msg.contains("UNIQUE") {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "username already exists" })),
            )
                .into_response();
        }
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": msg })),
        )
            .into_response();
    }
    tracing::info!("users: created {username} ({})", body.role);
    Json(json!({ "id": id, "username": username, "role": body.role })).into_response()
}

#[derive(Debug, Deserialize)]
pub struct UpdateUser {
    pub role: Option<String>,
    pub enabled: Option<bool>,
    /// Full replacement of section overrides; null = clear to role defaults.
    pub sections: Option<Option<serde_json::Value>>,
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Extension(ident): Extension<auth::AuthIdentity>,
    Json(body): Json<UpdateUser>,
) -> Response {
    // Cannot touch yourself (role/enable) — prevents admin lockout.
    // Sections are editable for admins only: anyone else could escalate.
    let self_id = ident.user_id.clone();
    let self_admin = is_admin_ident(&ident);
    if id == self_id && (body.role.is_some() || body.enabled == Some(false)) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cannot change own role or disable self" })),
        )
            .into_response();
    }
    if id == self_id && body.sections.is_some() && !self_admin {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cannot change own rights" })),
        )
            .into_response();
    }
    if let Some(r) = &body.role {
        if !valid_role(r) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "role must be admin|operator|viewer|prompter" })),
            )
                .into_response();
        }
    }
    if let Some(Some(sections)) = &body.sections {
        if !sections.is_object() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "sections must be an object {section: bool}" })),
            )
                .into_response();
        }
        for k in sections.as_object().unwrap().keys() {
            if !auth::SECTIONS.contains(&k.as_str()) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("unknown section {k:?}") })),
                )
                    .into_response();
            }
        }
    }
    let db = state.db.lock().await;
    let target_role: Option<String> = db
        .conn
        .query_row("SELECT role FROM users WHERE id = ?1", [&id], |row| {
            row.get(0)
        })
        .ok();
    let target_role = match target_role {
        Some(r) => r,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    // Non-admins can neither touch admin accounts nor grant the admin role.
    // Admin targets are hidden from them entirely (404, as in list).
    if !is_admin_ident(&ident) {
        if target_role == "admin" {
            return StatusCode::NOT_FOUND.into_response();
        }
        if body.role.as_deref() == Some("admin") {
            return forbidden_admin();
        }
    }
    // Forbid disabling/demoting the last enabled admin.
    if body.enabled == Some(false)
        || body.role.as_deref() == Some("operator")
        || body.role.as_deref() == Some("viewer")
        || body.role.as_deref() == Some(auth::ROLE_PROMPTER)
    {
        let admins: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND enabled = 1 AND id != ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let is_admin: bool = db
            .conn
            .query_row(
                "SELECT role = 'admin' AND enabled = 1 FROM users WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if is_admin && admins == 0 {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "cannot disable/demote the last enabled admin" })),
            )
                .into_response();
        }
    }
    let sections_str = match &body.sections {
        None => None,
        Some(None) => Some(None),
        Some(Some(v)) => Some(Some(v.to_string())),
    };
    // Build dynamic UPDATE for provided fields only.
    let mut sets: Vec<&str> = Vec::new();
    if body.role.is_some() {
        sets.push("role = ?");
    }
    if body.enabled.is_some() {
        sets.push("enabled = ?");
    }
    if body.sections.is_some() {
        sets.push("sections = ?");
    }
    if sets.is_empty() {
        return Json(json!({ "ok": true })).into_response();
    }
    let sql = format!(
        "UPDATE users SET {}, updated_at = datetime('now') WHERE id = ?",
        sets.join(", ")
    );
    let mut params: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(r) = &body.role {
        params.push(r.clone().into());
    }
    if let Some(e) = body.enabled {
        params.push((e as i32).into());
    }
    if let Some(s) = sections_str {
        params.push(s.map(rusqlite::types::Value::from).unwrap_or(rusqlite::types::Value::Null));
    }
    params.push(id.clone().into());
    let params_ref: Vec<&dyn rusqlite::ToSql> =
        params.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
    if let Err(e) = db.conn.execute(&sql, params_ref.as_slice()) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response();
    }
    tracing::info!("users: updated {id}");
    Json(json!({ "ok": true })).into_response()
}

/// GET /users/roles — effective default sections per configurable role
/// (admin-configured overrides merged over the hardcoded matrix).
pub async fn roles(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let db = state.db.lock().await;
    let mut map = serde_json::Map::new();
    for role in auth::CONFIGURABLE_ROLES {
        map.insert(
            role.to_string(),
            serde_json::Value::Array(
                auth::role_base_sections(&db, role)
                    .into_iter()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
    }
    Json(serde_json::Value::Object({
        let mut top = serde_json::Map::new();
        top.insert("roles".into(), serde_json::Value::Object(map));
        top
    }))
}

#[derive(Debug, Deserialize)]
pub struct UpdateRoles {
    pub roles: std::collections::HashMap<String, Vec<String>>,
}

/// PUT /users/roles — replace default sections for configurable roles.
/// Admin role only (editing the matrix is privilege escalation otherwise).
pub async fn update_roles(
    State(state): State<Arc<AppState>>,
    Extension(ident): Extension<auth::AuthIdentity>,
    Json(body): Json<UpdateRoles>,
) -> Response {
    if !is_admin_ident(&ident) {
        return forbidden_admin();
    }
    for role in body.roles.keys() {
        if !auth::CONFIGURABLE_ROLES.contains(&role.as_str()) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("role {role:?} is not configurable") })),
            )
                .into_response();
        }
    }
    let mut clean: std::collections::HashMap<String, Vec<String>> = HashMap::new();
    for (role, secs) in &body.roles {
        let mut v: Vec<String> = secs
            .iter()
            .filter(|s| auth::SECTIONS.contains(&s.as_str()))
            .cloned()
            .collect();
        v.sort();
        v.dedup();
        clean.insert(role.clone(), v);
    }
    // Merge over previously stored overrides so partial updates work.
    let db = state.db.lock().await;
    let mut stored: std::collections::HashMap<String, Vec<String>> = db
        .conn
        .query_row(
            "SELECT value FROM server_settings WHERE key = 'role_sections'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    for (role, secs) in clean {
        stored.insert(role, secs);
    }
    let raw = serde_json::to_string(&stored).unwrap_or_else(|_| "{}".into());
    if db
        .conn
        .execute(
            "INSERT INTO server_settings (key, value) VALUES ('role_sections', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [&raw],
        )
        .is_err()
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "save failed" })),
        )
            .into_response();
    }
    tracing::warn!("users: role matrix updated by {}", ident.username);
    Json(json!({ "ok": true })).into_response()
}

/// POST /users/{id}/reset-password — new random password, returned once.
pub async fn reset_password(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Extension(ident): Extension<auth::AuthIdentity>,
) -> Response {
    let db = state.db.lock().await;
    let target: Option<(String, String)> = db
        .conn
        .query_row(
            "SELECT username, role FROM users WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let (username, role) = match target {
        Some(t) => t,
        None => {
            return StatusCode::NOT_FOUND.into_response();
        }
    };
    if role == "admin" && !is_admin_ident(&ident) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let username = username;
    let password = auth::random_password();
    let hash = match auth::hash_password(&password) {
        Ok(h) => h,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e })),
            )
                .into_response()
        }
    };
    if db
        .conn
        .execute(
            "UPDATE users SET password_hash = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![hash, id],
        )
        .is_err()
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "update failed" })),
        )
            .into_response();
    }
    tracing::warn!("users: password reset for {username}");
    Json(json!({ "username": username, "password": password })).into_response()
}

#[derive(Debug, Deserialize)]
pub struct SetPasswordBody {
    pub password: String,
}

/// POST /users/{id}/password — set an explicit password (admin only).
pub async fn set_password(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Extension(ident): Extension<auth::AuthIdentity>,
    Json(body): Json<SetPasswordBody>,
) -> Response {
    if body.password.len() < 8 || body.password.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "password must be 8..128 chars" })),
        )
            .into_response();
    }
    let db = state.db.lock().await;
    let target: Option<(String, String)> = db
        .conn
        .query_row(
            "SELECT username, role FROM users WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let (username, role) = match target {
        Some(t) => t,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    if role == "admin" && !is_admin_ident(&ident) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let hash = match auth::hash_password(&body.password) {
        Ok(h) => h,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e })),
            )
                .into_response()
        }
    };
    if db
        .conn
        .execute(
            "UPDATE users SET password_hash = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![hash, id],
        )
        .is_err()
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "update failed" })),
        )
            .into_response();
    }
    tracing::warn!("users: password set for {username} by admin");
    Json(json!({ "ok": true, "username": username })).into_response()
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Extension(ident): Extension<auth::AuthIdentity>,
) -> Response {
    // Only admins delete users (deletion is destructive; operators manage
    // day-to-day entities, not accounts).
    if !is_admin_ident(&ident) {
        return forbidden_admin();
    }
    let self_id = ident.user_id.clone();
    if id == self_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cannot delete yourself" })),
        )
            .into_response();
    }
    let db = state.db.lock().await;
    let target: Option<(String, bool)> = db
        .conn
        .query_row(
            "SELECT role, enabled FROM users WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
        )
        .ok();
    let (role, enabled) = match target {
        Some(t) => t,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    if role == "admin" && enabled {
        let others: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND enabled = 1 AND id != ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if others == 0 {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "cannot delete the last enabled admin" })),
            )
                .into_response();
        }
    }
    let _ = db
        .conn
        .execute("DELETE FROM users WHERE id = ?1", [&id]);
    tracing::warn!("users: deleted {id}");
    Json(json!({ "ok": true })).into_response()
}
