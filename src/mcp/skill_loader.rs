use std::path::Path;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    name: String,
    #[serde(default)]
    tool_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    tool_schema: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    argument_hint: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    allowed_tools: Option<Vec<String>>,
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

    collect_md_files(dir, dir, &mut |path| {
        match import_single_file(path, db, dir) {
            Ok(true) => imported += 1,
            Ok(false) => skipped += 1,
            Err(e) => errors.push(format!("{}: {}", path.display(), e)),
        }
    })?;

    Ok(ImportResult { imported, skipped, errors })
}

/// Recursively collect .md files, walking into subdirectories
fn collect_md_files(
    root: &Path,
    dir: &Path,
    f: &mut impl FnMut(&Path),
) -> Result<(), Box<dyn std::error::Error>> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_md_files(root, &path, f)?;
        } else if path.extension().map_or(true, |ext| ext != "md") {
            continue;
        } else {
            f(&path);
        }
    }
    Ok(())
}

fn import_single_file(
    path: &Path,
    db: &crate::db::Database,
    root: &Path,
) -> Result<bool, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;

    // Strip UTF-8 BOM if present
    let content = content.trim_start_matches('\u{feff}').trim();
    if !content.starts_with("---") {
        return Ok(false);
    }

    let end = content[3..].find("\n---").map(|i| i + 3).ok_or("Missing closing ---")?;
    let yaml_str = &content[3..end].trim();
    let body = content[end + 4..].trim();

    let fm: SkillFrontmatter = serde_yaml::from_str(yaml_str)
        .map_err(|e| format!("YAML parse error: {}", e))?;

    let tool_name = fm.tool_name.unwrap_or_else(|| fm.name.clone());
    let tool_schema = match (&fm.tool_schema, body.is_empty()) {
        (Some(s), _) => s.clone(),
        (None, false) => {
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

    // Infer category from relative path: `<root>/<group>/<skill>/SKILL.md`
    let rel = path.strip_prefix(root).unwrap_or(path);
    let category = fm.category.or_else(|| {
        let parent = rel.parent()?;
        // If parent has a grandparent (deeper than 1 level), use the group name
        if parent.components().count() > 1 {
            let grandparent = parent.parent()?;
            let comp = grandparent.components().next()?;
            Some(comp.as_os_str().to_string_lossy().to_string())
        } else {
            None
        }
    });

    let id = format!("skill-{}", tool_name);

    // Build metadata JSON from extra fields
    let mut meta = serde_json::Map::new();
    let raw: serde_json::Value = serde_yaml::from_str(yaml_str).unwrap_or_default();
    if let Some(obj) = raw.as_object() {
        for (k, v) in obj {
            if !["name", "tool_name", "description", "server_id", "tool_schema", "category", "version"]
                .contains(&k.as_str())
            {
                meta.insert(k.clone(), v.clone());
            }
        }
    }
    let metadata = if meta.is_empty() { None } else { Some(json!(meta).to_string()) };

    let result = db.conn.execute(
        "INSERT INTO skills (id, name, description, server_id, tool_name, tool_schema, category, version, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            name = ?2, description = ?3, server_id = ?4, tool_name = ?5,
            tool_schema = ?6, category = ?7, version = ?8, metadata = ?9,
            updated_at = datetime('now')",
        rusqlite::params![
            id, fm.name, fm.description, fm.server_id, tool_name, tool_schema, category, fm.version, metadata
        ],
    );
    if let Err(rusqlite::Error::SqliteFailure(e, _)) = &result {
        if e.code == rusqlite::ErrorCode::ConstraintViolation {
            db.conn.execute(
                "INSERT INTO skills (id, name, description, server_id, tool_name, tool_schema, category, version, metadata)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                    name = ?2, description = ?3, server_id = NULL, tool_name = ?4,
                    tool_schema = ?5, category = ?6, version = ?7, metadata = ?8,
                    updated_at = datetime('now')",
                rusqlite::params![
                    id, fm.name, fm.description, tool_name, tool_schema, category, fm.version, metadata
                ],
            )?;
        } else {
            result?;
        }
    }

    tracing::info!("Imported skill '{}' from {}", fm.name, path.display());
    Ok(true)
}
