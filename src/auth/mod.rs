//! Bearer-token auth for the HTTP API.
//!
//! * Token hash is stored in `server_settings(api_token_hash)` (SHA-256, hex).
//! * On first boot a random token is generated and printed to the log **once**.
//! * `Authorization: Bearer <token>` is required for every `/api/*` route
//!   except `/health`. `OPTIONS` (CORS preflight) always passes.
//! * Rotate via `POST /api/admin/auth/rotate` (returns the new plaintext token).

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

const SETTING_KEY: &str = "api_token_hash";

fn hash_token(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    format!("{:x}", h.finalize())
}

fn new_token() -> String {
    format!("ai1c_{}", uuid::Uuid::new_v4().simple())
}

/// Ensure a token exists. Returns `Some(plaintext)` only when newly generated.
pub fn ensure_token(db: &Database) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let exists: bool = db.conn.query_row(
        "SELECT COUNT(*) > 0 FROM server_settings WHERE key = ?1",
        [SETTING_KEY],
        |row| row.get(0),
    )?;
    if exists {
        return Ok(None);
    }
    let token = new_token();
    db.conn.execute(
        "INSERT INTO server_settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![SETTING_KEY, hash_token(&token)],
    )?;
    Ok(Some(token))
}

pub fn verify(db: &Database, bearer: &str) -> bool {
    let stored: Result<String, _> = db.conn.query_row(
        "SELECT value FROM server_settings WHERE key = ?1",
        [SETTING_KEY],
        |row| row.get(0),
    );
    match stored {
        Ok(h) => h == hash_token(bearer),
        Err(_) => false,
    }
}

/// Generate a replacement token, store its hash, return plaintext.
pub fn rotate(db: &Database) -> Result<String, Box<dyn std::error::Error>> {
    let token = new_token();
    db.conn.execute(
        "INSERT INTO server_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![SETTING_KEY, hash_token(&token)],
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
