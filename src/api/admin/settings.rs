//! Generic `server_settings` key/value CRUD (used for `search_binary`,
//! `search_index_dir`, `auth_required`, etc.). Token material is never exposed
//! here — use `/api/admin/auth/token`.

use std::sync::Arc;
use axum::{
    extract::State,
    Json,
};
use serde::{Deserialize, Serialize};

use super::super::AppState;

#[derive(Debug, Serialize)]
pub struct Setting {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PutSetting {
    pub key: String,
    pub value: String,
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<Setting>> {
    let db = state.db.lock().await;
    let mut stmt = db
        .conn
        .prepare("SELECT key, value FROM server_settings ORDER BY key")
        .unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap();
    Json(
        rows
            .flatten()
            .map(|(k, v)| Setting {
                value: if k == "api_token_hash" || k == "api_token" {
                    None
                } else {
                    Some(v)
                },
                key: k,
            })
            .collect(),
    )
}

pub async fn upsert(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PutSetting>,
) -> Result<Json<Setting>, super::AppError> {
    if body.key.trim().is_empty()
        || body.key == "api_token_hash"
        || body.key == "api_token"
    {
        return Err(super::AppError::msg("invalid key"));
    }
    let db = state.db.lock().await;
    db.conn.execute(
        "INSERT INTO server_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![body.key, body.value],
    )?;
    Ok(Json(Setting {
        key: body.key,
        value: Some(body.value),
    }))
}
