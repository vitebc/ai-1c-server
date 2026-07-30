use std::sync::Arc;
use std::path::Path as FilePath;
use std::io::Write;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};


use super::super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct SkillRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub instruction: Option<String>,
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
    pub instruction: Option<String>,
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
    pub instruction: Option<String>,
    pub server_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_schema: Option<String>,
    pub category: Option<String>,
    pub version: Option<String>,
    pub enabled: Option<bool>,
    pub metadata: Option<String>,
}

const SKILL_COLS: &str = "id, name, description, instruction, server_id, tool_name, tool_schema, category, version, enabled, metadata, created_at, updated_at";

fn row_to_skill(row: &rusqlite::Row) -> rusqlite::Result<SkillRow> {
    Ok(SkillRow {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        instruction: row.get(3)?,
        server_id: row.get(4)?,
        tool_name: row.get(5)?,
        tool_schema: row.get(6)?,
        category: row.get(7)?,
        version: row.get(8)?,
        enabled: row.get::<_, i32>(9)? != 0,
        metadata: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<SkillRow>> {
    let db = state.db.lock().await;
    let mut stmt = db.conn.prepare(&format!("SELECT {} FROM skills ORDER BY name", SKILL_COLS)).unwrap();
    Json(stmt.query_map([], row_to_skill).unwrap().flatten().collect())
}

pub async fn get_by_id(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SkillRow>, super::NotFound> {
    let db = state.db.lock().await;
    let row = db.conn.query_row(
        &format!("SELECT {} FROM skills WHERE id = ?1", SKILL_COLS),
        [&id],
        row_to_skill,
    ).map_err(|_| super::NotFound)?;
    Ok(Json(row))
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateSkill>,
) -> Result<Json<SkillRow>, super::AppError> {
    let id = body.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let db = state.db.lock().await;
    db.conn.execute(
        &format!("INSERT INTO skills ({}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)", SKILL_COLS),
        rusqlite::params![
            id, body.name, body.description, body.instruction, body.server_id, body.tool_name,
            body.tool_schema, body.category, body.version, body.enabled.unwrap_or(true) as i32, body.metadata,
        ],
    )?;
    drop(db);
    get_by_id(State(state), Path(id)).await.map_err(Into::into)
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateSkill>,
) -> Result<Json<SkillRow>, super::AppError> {
    let db = state.db.lock().await;
    let existing = db.conn.query_row(
        &format!("SELECT {} FROM skills WHERE id = ?1", SKILL_COLS),
        [&id],
        row_to_skill,
    ).map_err(|_| super::NotFound)?;

    let name = body.name.as_deref().unwrap_or(&existing.name).to_string();
    let tool_name = body.tool_name.as_deref().unwrap_or(&existing.tool_name).to_string();
    let new_description = body.description.clone().unwrap_or_else(|| existing.description.clone().unwrap_or_default());
    let new_instruction = body.instruction.clone().unwrap_or_else(|| existing.instruction.clone().unwrap_or_default());
    let new_sid = body.server_id.clone().or_else(|| existing.server_id.clone());
    let new_schema = body.tool_schema.clone().unwrap_or(existing.tool_schema.clone());
    let new_cat = body.category.clone().or_else(|| existing.category.clone());
    let new_ver = body.version.clone().or_else(|| existing.version.clone());
    let new_enabled = body.enabled.unwrap_or(existing.enabled) as i32;
    let new_meta = body.metadata.clone().or_else(|| existing.metadata.clone());

    db.conn.execute(
        "UPDATE skills SET name=?1, description=?2, instruction=?3, server_id=?4, tool_name=?5,
         tool_schema=?6, category=?7, version=?8, enabled=?9, metadata=?10, updated_at=datetime('now') WHERE id=?11",
        rusqlite::params![
            name, new_description, new_instruction, new_sid, tool_name,
            new_schema, new_cat, new_ver, new_enabled, new_meta, id,
        ],
    )?;

    // Sync to disk: write SKILL.md
    let skills_dir = FilePath::new(&state.data_dir).join("skills").join(&tool_name);
    let frontmatter = build_frontmatter_yaml(&name, &new_description, &tool_name, &existing);
    let md_content = format!("---\n{}\n---\n\n{}", frontmatter.trim(), new_instruction);
    if let Some(parent) = skills_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&skills_dir.join("SKILL.md"), &md_content);

    drop(db);
    get_by_id(State(state), Path(id)).await.map_err(Into::into)
}

fn build_frontmatter_yaml(name: &str, description: &str, tool_name: &str, existing: &SkillRow) -> String {
    let mut map = serde_json::Map::new();
    map.insert("name".into(), serde_json::Value::String(name.to_string()));
    if !description.is_empty() { map.insert("description".into(), serde_json::Value::String(description.to_string())); }
    map.insert("tool_name".into(), serde_json::Value::String(tool_name.to_string()));
    if let Some(cat) = &existing.category { map.insert("category".into(), serde_json::Value::String(cat.clone())); }
    if let Some(ver) = &existing.version { map.insert("version".into(), serde_json::Value::String(ver.clone())); }
    if let Some(sid) = &existing.server_id { map.insert("server_id".into(), serde_json::Value::String(sid.clone())); }
    if let Some(meta) = &existing.metadata {
        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(meta) {
            if let Some(obj) = obj.as_object() {
                for (k, v) in obj {
                    if !["name", "description", "tool_name", "category", "version", "server_id"].contains(&k.as_str()) {
                        map.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }
    serde_yaml::to_string(&map).unwrap_or_default()
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, super::AppError> {
    let db = state.db.lock().await;
    // Get tool_name before deleting
    let tool_name: Option<String> = db.conn.query_row(
        "SELECT tool_name FROM skills WHERE id = ?1", [&id], |row| row.get(0)
    ).ok();
    let changes = db.conn.execute("DELETE FROM skills WHERE id = ?1", [&id])?;
    if changes == 0 { return Err(super::NotFound.into()); }
    drop(db);
    // Clean up disk
    if let Some(tn) = tool_name {
        let dir = FilePath::new(&state.data_dir).join("skills").join(&tn);
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(Json(()))
}

#[derive(Debug, Deserialize)]
pub struct ImportReq { pub dir: String }

pub async fn import_skills(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ImportReq>,
) -> Result<Json<crate::mcp::ImportResult>, super::AppError> {
    let db = state.db.lock().await;
    let data_dir = FilePath::new(&state.data_dir);
    let result = crate::mcp::import_skills_from_dir(&db, FilePath::new(&body.dir), data_dir)?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
pub struct UploadReq { pub files: Vec<UploadedFile> }

#[derive(Debug, Deserialize)]
pub struct UploadedFile { pub path: String, pub content: String }

pub async fn upload_skills(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UploadReq>,
) -> Result<Json<crate::mcp::ImportResult>, super::AppError> {
    let tmp = std::env::temp_dir().join("ai-1c-skills-upload");
    let _ = std::fs::remove_dir_all(&tmp);
    for file in &body.files {
        if !file.path.ends_with(".md") && !file.path.contains('/') { continue; }
        let dest = tmp.join(&file.path);
        if let Some(parent) = dest.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::write(&dest, &file.content)?;
    }
    let db = state.db.lock().await;
    let data_dir = FilePath::new(&state.data_dir);
    let result = crate::mcp::import_skills_from_dir(&db, &tmp, data_dir)?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(Json(result))
}

// ─── Export ZIP ────────────────────────────────────────────

pub async fn export_skills(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let data_dir = FilePath::new(&state.data_dir);
    let skills_dir = data_dir.join("skills");

    let mut buffer = Vec::new();
    if let Err(e) = write_skills_zip(&skills_dir, &mut buffer) {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("ZIP error: {}", e)).into_response();
    }
    let headers = [("Content-Type", "application/zip"), ("Content-Disposition", "attachment; filename=\"skills.zip\"")];
    (headers, buffer).into_response()
}

pub fn write_skills_zip(skills_dir: &FilePath, buffer: &mut Vec<u8>) -> Result<(), Box<dyn std::error::Error>> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(buffer));
    let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    if !skills_dir.exists() {
        zip.finish()?;
        return Ok(());
    }

    for entry in walkdir::WalkDir::new(skills_dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let rel = path.strip_prefix(skills_dir)?.to_string_lossy().to_string();
        if rel.is_empty() { continue; }
        let zip_path = format!(".opencode/skills/{}", rel);

        if path.is_dir() {
            zip.add_directory(&zip_path, options)?;
        } else {
            zip.start_file(&zip_path, options)?;
            let content = std::fs::read(path)?;
            zip.write_all(&content)?;
        }
    }

    zip.finish()?;
    Ok(())
}


