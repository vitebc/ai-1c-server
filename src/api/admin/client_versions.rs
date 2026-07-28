use std::sync::Arc;
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};

use super::super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct ClientVersionRow {
    pub id: String,
    pub version: String,
    pub platform: String,
    pub url: String,
    pub checksum: String,
    pub changelog: Option<String>,
    pub required: bool,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateVersion {
    pub id: Option<String>,
    pub version: String,
    pub platform: String,
    pub url: String,
    pub checksum: String,
    pub changelog: Option<String>,
    pub required: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateVersion {
    pub version: Option<String>,
    pub platform: Option<String>,
    pub url: Option<String>,
    pub checksum: Option<String>,
    pub changelog: Option<String>,
    pub required: Option<bool>,
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<ClientVersionRow>> {
    let db = state.db.lock().await;
    let mut stmt = db.conn.prepare(
        "SELECT id, version, platform, url, checksum, changelog, required, created_at
         FROM client_versions ORDER BY version DESC"
    ).unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(ClientVersionRow {
            id: row.get(0)?,
            version: row.get(1)?,
            platform: row.get(2)?,
            url: row.get(3)?,
            checksum: row.get(4)?,
            changelog: row.get(5)?,
            required: row.get::<_, i32>(6)? != 0,
            created_at: row.get(7)?,
        })
    }).unwrap();
    Json(rows.flatten().collect())
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateVersion>,
) -> Result<Json<ClientVersionRow>, super::AppError> {
    let id = body.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let db = state.db.lock().await;
    db.conn.execute(
        "INSERT INTO client_versions (id, version, platform, url, checksum, changelog, required)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            id, body.version, body.platform, body.url, body.checksum,
            body.changelog, body.required.unwrap_or(false) as i32,
        ],
    )?;
    drop(db);
    get_by_id(State(state), Path(id)).await.map_err(Into::into)
}

pub async fn get_by_id(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ClientVersionRow>, super::NotFound> {
    let db = state.db.lock().await;
    let row = db.conn.query_row(
        "SELECT id, version, platform, url, checksum, changelog, required, created_at
         FROM client_versions WHERE id = ?1",
        [&id],
        |row| {
            Ok(ClientVersionRow {
                id: row.get(0)?,
                version: row.get(1)?,
                platform: row.get(2)?,
                url: row.get(3)?,
                checksum: row.get(4)?,
                changelog: row.get(5)?,
                required: row.get::<_, i32>(6)? != 0,
                created_at: row.get(7)?,
            })
        },
    ).map_err(|_| super::NotFound)?;
    Ok(Json(row))
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateVersion>,
) -> Result<Json<ClientVersionRow>, super::AppError> {
    let db = state.db.lock().await;
    let existing = db.conn.query_row(
        "SELECT id, version, platform, url, checksum, changelog, required, created_at
         FROM client_versions WHERE id = ?1",
        [&id],
        |row| {
            Ok(ClientVersionRow {
                id: row.get(0)?,
                version: row.get(1)?,
                platform: row.get(2)?,
                url: row.get(3)?,
                checksum: row.get(4)?,
                changelog: row.get(5)?,
                required: row.get::<_, i32>(6)? != 0,
                created_at: row.get(7)?,
            })
        },
    ).map_err(|_| super::NotFound)?;

    db.conn.execute(
        "UPDATE client_versions SET version=?1, platform=?2, url=?3, checksum=?4, changelog=?5, required=?6 WHERE id=?7",
        rusqlite::params![
            body.version.as_deref().unwrap_or(&existing.version),
            body.platform.as_deref().unwrap_or(&existing.platform),
            body.url.as_deref().unwrap_or(&existing.url),
            body.checksum.as_deref().unwrap_or(&existing.checksum),
            body.changelog.or(existing.changelog),
            body.required.unwrap_or(existing.required) as i32,
            id,
        ],
    )?;
    drop(db);
    get_by_id(State(state), Path(id)).await.map_err(Into::into)
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, super::AppError> {
    let db = state.db.lock().await;
    let changes = db.conn.execute("DELETE FROM client_versions WHERE id = ?1", [&id])?;
    if changes == 0 {
        return Err(super::NotFound.into());
    }
    Ok(Json(()))
}
