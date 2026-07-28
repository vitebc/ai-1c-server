use std::sync::Arc;
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};

use super::super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigProfileRow {
    pub id: String,
    pub name: String,
    pub path: String,
    pub active: bool,
    pub last_indexed: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateConfig {
    pub id: Option<String>,
    pub name: String,
    pub path: String,
    pub active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConfig {
    pub name: Option<String>,
    pub path: Option<String>,
    pub active: Option<bool>,
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<ConfigProfileRow>> {
    let db = state.db.lock().await;
    let mut stmt = db.conn.prepare(
        "SELECT id, name, path, active, last_indexed, created_at, updated_at
         FROM config_profiles ORDER BY name"
    ).unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(ConfigProfileRow {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            active: row.get::<_, i32>(3)? != 0,
            last_indexed: row.get(4)?,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    }).unwrap();
    Json(rows.flatten().collect())
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateConfig>,
) -> Result<Json<ConfigProfileRow>, super::AppError> {
    let id = body.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let db = state.db.lock().await;
    db.conn.execute(
        "INSERT INTO config_profiles (id, name, path, active) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, body.name, body.path, body.active.unwrap_or(false) as i32],
    )?;
    drop(db);
    get_by_id(State(state), Path(id)).await.map_err(Into::into)
}

pub async fn get_by_id(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ConfigProfileRow>, super::NotFound> {
    let db = state.db.lock().await;
    let row = db.conn.query_row(
        "SELECT id, name, path, active, last_indexed, created_at, updated_at
         FROM config_profiles WHERE id = ?1",
        [&id],
        |row| {
            Ok(ConfigProfileRow {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                active: row.get::<_, i32>(3)? != 0,
                last_indexed: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    ).map_err(|_| super::NotFound)?;
    Ok(Json(row))
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateConfig>,
) -> Result<Json<ConfigProfileRow>, super::AppError> {
    let db = state.db.lock().await;
    let existing = db.conn.query_row(
        "SELECT id, name, path, active, last_indexed, created_at, updated_at
         FROM config_profiles WHERE id = ?1",
        [&id],
        |row| {
            Ok(ConfigProfileRow {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                active: row.get::<_, i32>(3)? != 0,
                last_indexed: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    ).map_err(|_| super::NotFound)?;

    db.conn.execute(
        "UPDATE config_profiles SET name=?1, path=?2, active=?3, updated_at=datetime('now') WHERE id=?4",
        rusqlite::params![
            body.name.as_deref().unwrap_or(&existing.name),
            body.path.as_deref().unwrap_or(&existing.path),
            body.active.unwrap_or(existing.active) as i32,
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
    let changes = db.conn.execute("DELETE FROM config_profiles WHERE id = ?1", [&id])?;
    if changes == 0 {
        return Err(super::NotFound.into());
    }
    Ok(Json(()))
}
