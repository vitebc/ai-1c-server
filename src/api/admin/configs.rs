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
    pub parent_id: Option<String>,
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
    pub parent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConfig {
    pub name: Option<String>,
    pub path: Option<String>,
    pub active: Option<bool>,
    /// Missing = keep, null = detach to main, value = attach to main.
    #[serde(default)]
    pub parent_id: Option<Option<String>>,
}

const ROW_SQL: &str = "SELECT id, name, path, active, parent_id, last_indexed, created_at, updated_at
     FROM config_profiles";

fn map_row(row: &rusqlite::Row) -> rusqlite::Result<ConfigProfileRow> {
    Ok(ConfigProfileRow {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        active: row.get::<_, i32>(3)? != 0,
        parent_id: row.get(4)?,
        last_indexed: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// All profiles: (mains first, then extensions). Used by search_sync.
pub fn load_all(db: &crate::db::Database) -> Vec<ConfigProfileRow> {
    let mut stmt = match db
        .conn
        .prepare(&format!("{ROW_SQL} ORDER BY name"))
    {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([], map_row)
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<ConfigProfileRow>> {
    let db = state.db.lock().await;
    let mut stmt = db.conn.prepare(
        "SELECT id, name, path, active, parent_id, last_indexed, created_at, updated_at
         FROM config_profiles ORDER BY name"
    ).unwrap();
    let rows = stmt.query_map([], map_row).unwrap();
    Json(rows.flatten().collect())
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateConfig>,
) -> Result<Json<ConfigProfileRow>, axum::response::Response> {
    use axum::response::IntoResponse;
    let id = body.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if body.parent_id.as_deref() == Some(id.as_str()) {
        return Err(super::BadRequest("parent_id cannot equal own id".into()).into_response());
    }
    // Parent must exist and must itself be a main profile (no nesting).
    if let Some(pid) = body.parent_id.as_deref() {
        let ok: bool = {
            let db = state.db.lock().await;
            db.conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM config_profiles WHERE id = ?1 AND parent_id IS NULL",
                    [pid],
                    |row| row.get(0),
                )
                .unwrap_or(false)
        };
        if !ok {
            return Err(super::BadRequest("parent_id must reference an existing main profile".into())
                .into_response());
        }
    }
    let db = state.db.lock().await;
    db.conn.execute(
        "INSERT INTO config_profiles (id, name, path, active, parent_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, body.name, body.path, body.active.unwrap_or(false) as i32, body.parent_id],
    ).map_err(|e| super::AppError::from(e).into_response())?;
    drop(db);
    let row = get_by_id(State(state.clone()), Path(id.clone()))
        .await
        .map_err(|e| super::AppError::from(e).into_response())?;
    super::search_sync::resync_search_servers(&state).await;
    Ok(row)
}

pub async fn get_by_id(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ConfigProfileRow>, super::NotFound> {
    let db = state.db.lock().await;
    let row = db.conn.query_row(
        "SELECT id, name, path, active, parent_id, last_indexed, created_at, updated_at
         FROM config_profiles WHERE id = ?1",
        [&id],
        map_row,
    ).map_err(|_| super::NotFound)?;
    Ok(Json(row))
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateConfig>,
) -> Result<Json<ConfigProfileRow>, axum::response::Response> {
    use axum::response::IntoResponse;
    let db = state.db.lock().await;
    let existing = db.conn.query_row(
        "SELECT id, name, path, active, parent_id, last_indexed, created_at, updated_at
         FROM config_profiles WHERE id = ?1",
        [&id],
        map_row,
    ).map_err(|_| super::NotFound.into_response())?;

    let new_parent: Option<String> = match body.parent_id {
        None => existing.parent_id.clone(),
        Some(v) => v,
    };
    if new_parent.as_deref() == Some(id.as_str()) {
        return Err(super::BadRequest("parent_id cannot equal own id".into()).into_response());
    }
    // A main profile with extensions cannot become an extension itself.
    if new_parent.is_some() {
        let has_children: bool = db.conn.query_row(
            "SELECT COUNT(*) > 0 FROM config_profiles WHERE parent_id = ?1",
            [&id],
            |row| row.get(0),
        ).unwrap_or(false);
        if has_children {
            return Err(super::BadRequest("profile with extensions cannot become an extension".into())
                .into_response());
        }
        let parent_ok: bool = db.conn.query_row(
            "SELECT COUNT(*) > 0 FROM config_profiles WHERE id = ?1 AND parent_id IS NULL AND id <> ?2",
            rusqlite::params![new_parent.as_deref().unwrap_or(""), id],
            |row| row.get(0),
        ).unwrap_or(false);
        if !parent_ok {
            return Err(super::BadRequest("parent_id must reference an existing main profile".into())
                .into_response());
        }
    }

    db.conn.execute(
        "UPDATE config_profiles SET name=?1, path=?2, active=?3, parent_id=?4, updated_at=datetime('now') WHERE id=?5",
        rusqlite::params![
            body.name.as_deref().unwrap_or(&existing.name),
            body.path.as_deref().unwrap_or(&existing.path),
            body.active.unwrap_or(existing.active) as i32,
            new_parent,
            id,
        ],
    ).map_err(|e| super::AppError::from(e).into_response())?;
    drop(db);
    let row = get_by_id(State(state.clone()), Path(id))
        .await
        .map_err(|e| super::AppError::from(e).into_response())?;
    super::search_sync::resync_search_servers(&state).await;
    Ok(row)
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
    drop(db);
    super::search_sync::resync_search_servers(&state).await;
    Ok(Json(()))
}
