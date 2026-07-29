use std::sync::Arc;
use std::path::Path as FilePath;
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};

use super::super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct SkillRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub server_id: Option<String>,
    pub tool_name: String,
    pub tool_schema: String,
    pub category: Option<String>,
    pub version: Option<String>,
    pub enabled: bool,
    pub metadata: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSkill {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub server_id: Option<String>,
    pub tool_name: String,
    pub tool_schema: String,
    pub category: Option<String>,
    pub version: Option<String>,
    pub enabled: Option<bool>,
    pub metadata: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSkill {
    pub name: Option<String>,
    pub description: Option<String>,
    pub server_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_schema: Option<String>,
    pub category: Option<String>,
    pub version: Option<String>,
    pub enabled: Option<bool>,
    pub metadata: Option<String>,
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<SkillRow>> {
    let db = state.db.lock().await;
    let mut stmt = db.conn.prepare(
        "SELECT id, name, description, server_id, tool_name, tool_schema, category, version, enabled, metadata, created_at, updated_at
         FROM skills ORDER BY name"
    ).unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(SkillRow {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            server_id: row.get(3)?,
            tool_name: row.get(4)?,
            tool_schema: row.get(5)?,
            category: row.get(6)?,
            version: row.get(7)?,
            enabled: row.get::<_, i32>(8)? != 0,
            metadata: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    }).unwrap();
    Json(rows.flatten().collect())
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateSkill>,
) -> Result<Json<SkillRow>, super::AppError> {
    let id = body.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let db = state.db.lock().await;
    db.conn.execute(
        "INSERT INTO skills (id, name, description, server_id, tool_name, tool_schema, category, version, enabled, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            id, body.name, body.description, body.server_id, body.tool_name, body.tool_schema,
            body.category, body.version, body.enabled.unwrap_or(true) as i32, body.metadata,
        ],
    )?;
    drop(db);
    get_by_id(State(state), Path(id)).await.map_err(Into::into)
}

pub async fn get_by_id(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SkillRow>, super::NotFound> {
    let db = state.db.lock().await;
    let row = db.conn.query_row(
        "SELECT id, name, description, server_id, tool_name, tool_schema, category, version, enabled, metadata, created_at, updated_at
         FROM skills WHERE id = ?1",
        [&id],
        |row| {
            Ok(SkillRow {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                server_id: row.get(3)?,
                tool_name: row.get(4)?,
                tool_schema: row.get(5)?,
                category: row.get(6)?,
                version: row.get(7)?,
                enabled: row.get::<_, i32>(8)? != 0,
                metadata: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        },
    ).map_err(|_| super::NotFound)?;
    Ok(Json(row))
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateSkill>,
) -> Result<Json<SkillRow>, super::AppError> {
    let db = state.db.lock().await;
    let existing = db.conn.query_row(
        "SELECT id, name, description, server_id, tool_name, tool_schema, category, version, enabled, metadata, created_at, updated_at
         FROM skills WHERE id = ?1",
        [&id],
        |row| {
            Ok(SkillRow {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                server_id: row.get(3)?,
                tool_name: row.get(4)?,
                tool_schema: row.get(5)?,
                category: row.get(6)?,
                version: row.get(7)?,
                enabled: row.get::<_, i32>(8)? != 0,
                metadata: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        },
    ).map_err(|_| super::NotFound)?;

    db.conn.execute(
        "UPDATE skills SET name=?1, description=?2, server_id=?3, tool_name=?4, tool_schema=?5,
         category=?6, version=?7, enabled=?8, metadata=?9, updated_at=datetime('now') WHERE id=?10",
        rusqlite::params![
            body.name.as_deref().unwrap_or(&existing.name),
            body.description.or(existing.description),
            body.server_id.or(existing.server_id),
            body.tool_name.as_deref().unwrap_or(&existing.tool_name),
            body.tool_schema.as_deref().unwrap_or(&existing.tool_schema),
            body.category.or(existing.category),
            body.version.or(existing.version),
            body.enabled.unwrap_or(existing.enabled) as i32,
            body.metadata.or(existing.metadata),
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
    let changes = db.conn.execute("DELETE FROM skills WHERE id = ?1", [&id])?;
    if changes == 0 {
        return Err(super::NotFound.into());
    }
    Ok(Json(()))
}

#[derive(Debug, Deserialize)]
pub struct ImportReq {
    pub dir: String,
}

pub async fn import_skills(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportReq>,
) -> Result<Json<crate::mcp::ImportResult>, super::AppError> {
    let db = state.db.lock().await;
    let result = crate::mcp::import_skills_from_dir(&db, FilePath::new(&body.dir))?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
pub struct UploadReq {
    pub files: Vec<UploadedFile>,
}

#[derive(Debug, Deserialize)]
pub struct UploadedFile {
    pub path: String,
    pub content: String,
}

pub async fn upload_skills(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UploadReq>,
) -> Result<Json<crate::mcp::ImportResult>, super::AppError> {
    let tmp = std::env::temp_dir().join("ai-1c-skills-upload");
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp)?;
    }
    for file in &body.files {
        if !file.path.ends_with(".md") { continue; }
        let dest = tmp.join(&file.path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest, &file.content)?;
    }
    let db = state.db.lock().await;
    let result = crate::mcp::import_skills_from_dir(&db, &tmp)?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(Json(result))
}
