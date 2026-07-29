use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    name: String,
    tool_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    server_id: Option<String>,
    tool_schema: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

pub fn import_skills_from_dir(
    db: &crate::db::Database,
    dir: &Path,
) -> Result<ImportResult, Box<dyn std::error::Error>> {
    if !dir.exists() {
        return Err(format!("Directory not found: {}", dir.display()).into());
    }

    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut errors = Vec::new();

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().map_or(true, |ext| ext != "md") {
            continue;
        }

        match import_single_file(&path, db) {
            Ok(true) => imported += 1,
            Ok(false) => skipped += 1,
            Err(e) => errors.push(format!("{}: {}", path.display(), e)),
        }
    }

    Ok(ImportResult { imported, skipped, errors })
}

fn import_single_file(path: &Path, db: &crate::db::Database) -> Result<bool, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;

    // Strip UTF-8 BOM if present
    let content = content.trim_start_matches('\u{feff}').trim();
    if !content.starts_with("---") {
        return Ok(false); // skip files without frontmatter
    }

    let end = content[3..].find("\n---").map(|i| i + 3).ok_or("Missing closing ---")?;
    let yaml_str = &content[3..end].trim();
    let body = content[end + 4..].trim();

    let fm: SkillFrontmatter = serde_yaml::from_str(yaml_str)
        .map_err(|e| format!("YAML parse error: {}", e))?;

    let tool_schema = match (&fm.tool_schema, body.is_empty()) {
        (Some(s), _) => s.clone(),
        (None, false) => {
            // Try to extract JSON schema from body
            if let Some(start) = body.find("```json") {
                let after = &body[start + 7..];
                if let Some(end) = after.find("```") {
                    after[..end].trim().to_string()
                } else {
                    return Err("Unclosed ```json block".into());
                }
            } else {
                "{}".into()
            }
        }
        (None, true) => "{}".into(),
    };

    let id = format!("skill-{}", fm.tool_name);

    let result = db.conn.execute(
        "INSERT INTO skills (id, name, description, server_id, tool_name, tool_schema, category, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            name = ?2, description = ?3, server_id = ?4, tool_name = ?5,
            tool_schema = ?6, category = ?7, version = ?8,
            updated_at = datetime('now')",
        rusqlite::params![
            id,
            fm.name,
            fm.description,
            fm.server_id,
            fm.tool_name,
            tool_schema,
            fm.category,
            fm.version,
        ],
    );
    if let Err(rusqlite::Error::SqliteFailure(e, _)) = &result {
        if e.code == rusqlite::ErrorCode::ConstraintViolation {
            // FK constraint — retry without server_id
            db.conn.execute(
                "INSERT INTO skills (id, name, description, server_id, tool_name, tool_schema, category, version)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                    name = ?2, description = ?3, server_id = NULL, tool_name = ?4,
                    tool_schema = ?5, category = ?6, version = ?7,
                    updated_at = datetime('now')",
                rusqlite::params![
                    id, fm.name, fm.description, fm.tool_name, tool_schema, fm.category, fm.version,
                ],
            )?;
        } else {
            result?;
        }
    }

    tracing::info!("Imported skill '{}' from {}", fm.name, path.display());
    Ok(true)
}
