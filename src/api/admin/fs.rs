//! Read-only filesystem browser for the Admin UI
//! (`GET /api/admin/fs/browse?path=...`).
//!
//! Used by the MCP server form to pick a binary via point-and-click
//! instead of typing an absolute path. Auth is enforced by the global
//! Bearer middleware; symlinks are not followed for the entry type check.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use super::super::AppState;

#[derive(Debug, Deserialize)]
pub struct BrowseQuery {
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct BrowseResult {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FsEntry>,
}

pub async fn browse(
    State(_state): State<Arc<AppState>>,
    Query(q): Query<BrowseQuery>,
) -> Result<Json<BrowseResult>, super::AppError> {
    let raw = q.path.as_deref().unwrap_or("/").trim();
    let raw = if raw.is_empty() { "/" } else { raw };
    let dir = std::path::PathBuf::from(raw);
    let dir = if dir.is_absolute() {
        dir
    } else {
        std::path::PathBuf::from("/").join(dir)
    };

    let read = std::fs::read_dir(&dir)
        .map_err(|e| super::AppError::msg(format!("Cannot list '{}': {e}", dir.display())))?;

    let mut entries: Vec<FsEntry> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(f) => f,
            Err(_) => continue,
        };
        let is_dir = ft.is_dir();
        let size = if is_dir {
            None
        } else {
            entry.metadata().ok().map(|m| m.len())
        };
        entries.push(FsEntry {
            path: entry.path().to_string_lossy().to_string(),
            name,
            is_dir,
            size,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(Json(BrowseResult {
        parent: dir.parent().map(|p| p.to_string_lossy().to_string()),
        path: dir.to_string_lossy().to_string(),
        entries,
    }))
}
