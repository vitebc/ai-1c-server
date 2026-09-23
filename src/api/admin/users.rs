//! User management (admin only — enforced by the RBAC section map).
//! Passwords: argon2, min 8 chars. Reset returns plaintext **once**.

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

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<UserDto>> {
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
    Json(rows.flatten().collect())
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
    matches!(role, "admin" | "operator" | "viewer")
}

pub async fn create(
    State(state): State<Arc<AppState>>,
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
            Json(json!({ "error": "role must be admin|operator|viewer" })),
        )
            .into_response();
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
    let self_id = ident.user_id.clone();
    if id == self_id && (body.role.is_some() || body.enabled == Some(false)) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cannot change own role or disable self" })),
        )
            .into_response();
    }
    if let Some(r) = &body.role {
        if !valid_role(r) {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "role must be admin|operator|viewer" })),
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
    let exists: bool = db
        .conn
        .query_row("SELECT COUNT(*) > 0 FROM users WHERE id = ?1", [&id], |row| {
            row.get(0)
        })
        .unwrap_or(false);
    if !exists {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Forbid disabling/demoting the last enabled admin.
    if body.enabled == Some(false) || body.role.as_deref() == Some("operator") || body.role.as_deref() == Some("viewer") {
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

/// POST /users/{id}/reset-password — new random password, returned once.
pub async fn reset_password(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let db = state.db.lock().await;
    let username: Option<String> = db
        .conn
        .query_row("SELECT username FROM users WHERE id = ?1", [&id], |row| {
            row.get(0)
        })
        .ok();
    let username = match username {
        Some(u) => u,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
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
    let username: Option<String> = db
        .conn
        .query_row("SELECT username FROM users WHERE id = ?1", [&id], |row| {
            row.get(0)
        })
        .ok();
    let username = match username {
        Some(u) => u,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
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
