use std::path::Path;
use std::fs;
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
    argument_hint: Option<String>,
    #[serde(default)]
    allowed_tools: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

/// Scan a root skills dir, import each SKILL.md into DB and copy files to data/skills/
pub fn import_skills_from_dir(
    db: &crate::db::Database,
    dir: &Path,
    data_dir: &Path,
) -> Result<ImportResult, Box<dyn std::error::Error>> {
    if !dir.exists() {
        return Err(format!("Directory not found: {}", dir.display()).into());
    }

    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut errors = Vec::new();

    collect_md_files(dir, dir, &mut |path| {
        match import_single_file(path, db, dir, data_dir) {
            Ok(true) => imported += 1,
            Ok(false) => skipped += 1,
            Err(e) => errors.push(format!("{}: {}", path.display(), e)),
        }
    })?;

    Ok(ImportResult { imported, skipped, errors })
}

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
    data_dir: &Path,
) -> Result<bool, Box<dyn std::error::Error>> {
    let content = fs::read_to_string(path)?
        .trim_start_matches('\u{feff}')
        .trim()
        .to_string();
    if !content.starts_with("---") {
        return Ok(false);
    }

    let end = content[3..].find("\n---").map(|i| i + 3).ok_or("Missing closing ---")?;
    let yaml_str = &content[3..end].trim();
    let body = content[end + 4..].trim();

    let fm: SkillFrontmatter = serde_yaml::from_str(yaml_str)
        .map_err(|e| format!("YAML parse error: {}", e))?;

    let tool_name = fm.tool_name.unwrap_or_else(|| fm.name.clone());
    let instruction = body.to_string();
    let tool_schema = match &fm.tool_schema {
        Some(s) => s.clone(),
        None => "{}".into(),
    };

    // Infer category from relative path
    let rel = path.strip_prefix(root).unwrap_or(path);
    let category = fm.category.or_else(|| {
        let parent = rel.parent()?;
        if parent.components().count() > 1 {
            let grandparent = parent.parent()?;
            let comp = grandparent.components().next()?;
            Some(comp.as_os_str().to_string_lossy().to_string())
        } else {
            None
        }
    });

    // Collect subdirectory files (scripts, references, preset)
    let skill_source_dir = path.parent().unwrap_or(root);
    let (files_meta, file_list) = collect_skill_files(skill_source_dir);

    // Build metadata JSON
    let mut meta: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
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
    if !files_meta.is_empty() {
        meta.extend(files_meta);
    }
    let metadata = if meta.is_empty() { None } else { Some(json!(meta).to_string()) };

    let id = format!("skill-{}", tool_name);

    // Write to DB
    db.conn.execute(
        "INSERT INTO skills (id, name, description, instruction, server_id, tool_name, tool_schema, category, version, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            name=?2, description=?3, instruction=?4, server_id=?5, tool_name=?6,
            tool_schema=?7, category=?8, version=?9, metadata=?10,
            updated_at=datetime('now')",
        rusqlite::params![
            id, fm.name, fm.description, instruction, fm.server_id,
            tool_name, tool_schema, category, fm.version, metadata
        ],
    ).unwrap_or_else(|_| {
        // FK fallback — null server_id
        db.conn.execute(
            "INSERT INTO skills (id, name, description, instruction, server_id, tool_name, tool_schema, category, version, metadata)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name=?2, description=?3, instruction=?4, server_id=NULL, tool_name=?5,
                tool_schema=?6, category=?7, version=?8, metadata=?9,
                updated_at=datetime('now')",
            rusqlite::params![
                id, fm.name, fm.description, instruction,
                tool_name, tool_schema, category, fm.version, metadata
            ],
        ).ok();
        0
    });

    // Copy skill files to data/skills/<tool_name>/
    let dest_dir = data_dir.join("skills").join(&tool_name);
    if skill_source_dir != dest_dir {
        fs::create_dir_all(&dest_dir)?;
        // Copy SKILL.md
        let dest_md = dest_dir.join("SKILL.md");
        fs::write(&dest_md, &content)?;
        // Copy subdirectories
        for file in &file_list {
            let src = skill_source_dir.join(file);
            let dst = dest_dir.join(file);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            let _ = fs::copy(&src, &dst);
        }
    }

    tracing::info!("Imported skill '{}' from {}", fm.name, path.display());
    Ok(true)
}

/// Collect file paths from scripts/, references/, preset/ subdirectories
fn collect_skill_files(skill_dir: &Path) -> (serde_json::Map<String, serde_json::Value>, Vec<String>) {
    let mut meta = serde_json::Map::new();
    let mut all_files = Vec::new();
    for sub in &["scripts", "references", "preset"] {
        let sub_dir = skill_dir.join(sub);
        if !sub_dir.exists() { continue; }
        let mut files = Vec::new();
        if let Ok(entries) = fs::read_dir(&sub_dir) {
            for e in entries.flatten() {
                if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    let rel = format!("{}/{}", sub, e.file_name().to_string_lossy());
                    files.push(rel.clone());
                    all_files.push(rel);
                }
            }
        }
        if !files.is_empty() {
            meta.insert((*sub).to_string(), json!(files));
        }
    }
    (meta, all_files)
}
