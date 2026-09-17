//! Bearer-token auth for the HTTP API (opt-in, OFF by default).
//!
//! * Plaintext token in `server_settings(api_token)` — shown in Admin UI.
//! * Legacy hash in `server_settings(api_token_hash)` still verifies
//!   (installs predating plaintext storage).
//! * On first boot a random token is generated and printed to the log **once**.
//! * When `server_settings(auth_required)` is truthy, `Authorization: Bearer`
//!   is required for every `/api/*` route except `/health`.
//!   `OPTIONS` (CORS preflight) always passes.
//! * Manage via Admin UI (Dashboard → API Access) or API:
//!   `GET /api/admin/auth/token`, `POST /api/admin/auth/rotate`.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::api::AppState;
use crate::db::Database;

const HASH_KEY: &str = "api_token_hash";
const TOKEN_KEY: &str = "api_token";

fn hash_token(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    format!("{:x}", h.finalize())
}

/// Auth is opt-in: required only when `server_settings(auth_required)`
/// is set to a truthy value. Absent (fresh installs) = open API.
pub fn is_auth_required(db: &Database) -> bool {
    let val: Result<String, _> = db.conn.query_row(
        "SELECT value FROM server_settings WHERE key = 'auth_required'",
        [],
        |row| row.get(0),
    );
    match val {
        Ok(v) => !matches!(
            v.trim().to_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        ),
        Err(_) => false,
    }
}

fn new_token() -> String {
    format!("ai1c_{}", uuid::Uuid::new_v4().simple())
}

fn get_setting(db: &Database, key: &str) -> Option<String> {
    db.conn
        .query_row(
            "SELECT value FROM server_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .ok()
}

/// Ensure a token exists. Returns `Some(plaintext)` only when newly generated.
pub fn ensure_token(db: &Database) -> Result<Option<String>, Box<dyn std::error::Error>> {
    if get_setting(db, TOKEN_KEY).is_some() || get_setting(db, HASH_KEY).is_some() {
        return Ok(None);
    }
    let token = new_token();
    db.conn.execute(
        "INSERT INTO server_settings (key, value) VALUES (?1, ?2), (?3, ?4)",
        rusqlite::params![TOKEN_KEY, token, HASH_KEY, hash_token(&token)],
    )?;
    Ok(Some(token))
}

/// Current plaintext token, if stored (legacy installs: None until rotate).
pub fn current_token(db: &Database) -> Option<String> {
    get_setting(db, TOKEN_KEY).filter(|s| !s.trim().is_empty())
}

pub fn verify(db: &Database, bearer: &str) -> bool {
    if let Some(t) = current_token(db) {
        if t == bearer {
            return true;
        }
    }
    // Legacy hash fallback.
    match get_setting(db, HASH_KEY) {
        Some(h) => h == hash_token(bearer),
        None => false,
    }
}

/// Generate a replacement token, store it (plaintext + hash), return plaintext.
pub fn rotate(db: &Database) -> Result<String, Box<dyn std::error::Error>> {
    let token = new_token();
    db.conn.execute(
        "INSERT INTO server_settings (key, value) VALUES (?1, ?2), (?3, ?4)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![TOKEN_KEY, token, HASH_KEY, hash_token(&token)],
    )?;
    Ok(token)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized: valid Bearer token required" })),
    )
        .into_response()
}

pub async fn bearer_auth(
    State(state): State<Arc<AppState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();
    if !path.starts_with("/api/") || req.method() == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }
    // NOTE: the db guard must be dropped BEFORE next.run — otherwise the
    // downstream handler deadlocks trying to lock the same mutex.
    let auth_disabled = {
        let db = state.db.lock().await;
        !is_auth_required(&db)
    };
    if auth_disabled {
        return next.run(req).await;
    }
    let bearer: Option<String> = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t.trim().to_string());
    let ok = match bearer {
        Some(t) => {
            let db = state.db.lock().await;
            verify(&db, &t)
        }
        None => false,
    };
    if ok {
        next.run(req).await
    } else {
        unauthorized()
    }
}

/// POST /api/admin/auth/rotate — replace token, return new plaintext (once).
pub async fn rotate_handler(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, super::api::admin::AppError> {
    let db = state.db.lock().await;
    let token = rotate(&db)?;
    tracing::warn!("API token rotated");
    Ok(Json(json!({ "token": token })))
}

/// GET /api/admin/auth/token — current token (for Admin UI display) +
/// whether auth is enforced. Reachable without a token only when auth is off.
pub async fn token_handler(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let db = state.db.lock().await;
    Json(json!({
        "token": current_token(&db),
        "auth_required": is_auth_required(&db),
    }))
}
