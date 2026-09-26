//! File management for the `1c-ai-agent` project:
//! `backend/agents/<name>/AGENT.md`, `backend/skills/<name>/SKILL.md`,
//! `backend/patterns/<name>.md`.
//!
//! Mirrors the backend's flat-frontmatter rules (`app/frontmatter.py`):
//! file must start with `---`, `key: value` lines (strings or `[a, b]`
//! lists), `#` comments skipped. `name` must match the folder/file name
//! (`^[a-z0-9-]+$`). Broken files are reported, never fatal.
//!
//! Project root comes from `server_settings(agent_project_root)`,
//! default `/root/project/1c-ai-agent`. All paths are jailed inside it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{Extension, Path as AxPath, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::super::AppState;

/// Default project root follows the server process owner:
/// `$HOME/project/1c-ai-agent` (e.g. `/root/...` or `/home/test/...`).
/// Overridable via `server_settings(agent_project_root)`.
pub fn default_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
    PathBuf::from(home).join("project/1c-ai-agent")
}

/// Tool names known to the agent backend (mock + live + built-in).
/// Used for the editor multiselect; unknown names are only warned about.
pub const KNOWN_TOOLS: &[&str] = &[
    "execute_select",
    "get_counterparty",
    "get_metadata_structure",
    "get_pattern",
    "get_stock_balance",
    "list_metadata_objects",
    "run_skd_report",
    "search_knowledge_base",
    "validate_query",
];

fn project_root(db: &crate::db::Database) -> PathBuf {
    let custom: Option<String> = db
        .conn
        .query_row(
            "SELECT value FROM server_settings WHERE key = 'agent_project_root'",
            [],
            |row| row.get(0),
        )
        .ok();
    custom.map(PathBuf::from).unwrap_or_else(default_root)
}

fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn jail(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let joined = root.join(rel);
    // Lexical containment check (no symlink following needed: we never
    // create symlinks, and `..` components are rejected by name validation;
    // this is a second layer).
    let root_c = root.components().collect::<Vec<_>>();
    let mut cur: Vec<std::path::Component> = Vec::new();
    for comp in joined.components() {
        match comp {
            std::path::Component::ParentDir => {
                cur.pop();
            }
            std::path::Component::CurDir => {}
            c => cur.push(c),
        }
    }
    let norm: PathBuf = cur.iter().collect();
    if norm.starts_with(root) && norm != PathBuf::from(root_c.iter().collect::<PathBuf>()) {
        Ok(norm)
    } else {
        Err("path escapes project root".into())
    }
}

// ─── frontmatter (mirror of app/frontmatter.py) ─────────────────────

fn parse_value(raw: &str) -> Result<Value, String> {
    let raw = raw.trim();
    if let Some(inner) = raw.strip_prefix('[') {
        let inner = inner
            .strip_suffix(']')
            .ok_or_else(|| "list is missing closing ']'".to_string())?;
        let items: Vec<Value> = inner
            .split(',')
            .map(|p| p.trim().trim_matches(|c| c == '\'' || c == '"'))
            .filter(|p| !p.is_empty())
            .map(|p| Value::String(p.to_string()))
            .collect();
        return Ok(Value::Array(items));
    }
    if raw.len() >= 2
        && ((raw.starts_with('"') && raw.ends_with('"'))
            || (raw.starts_with('\'') && raw.ends_with('\'')))
    {
        return Ok(Value::String(raw[1..raw.len() - 1].to_string()));
    }
    Ok(Value::String(raw.to_string()))
}

fn parse_frontmatter(text: &str) -> Result<(HashMap<String, Value>, String), String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return Err("file must start with '---'".into());
    }
    let end = lines
        .iter()
        .skip(1)
        .position(|l| l.trim() == "---")
        .ok_or_else(|| "missing closing '---'".to_string())?
        + 1;
    let mut meta = HashMap::new();
    for raw in &lines[1..end] {
        let t = raw.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let (k, v) = t
            .split_once(':')
            .ok_or_else(|| format!("frontmatter line without ':': {t:?}"))?;
        meta.insert(
            k.trim().to_string(),
            parse_value(v).map_err(|e| format!("key {:?}: {e}", k.trim()))?,
        );
    }
    Ok((meta, lines[end + 1..].join("\n").trim().to_string()))
}

fn render_list(items: &[String]) -> String {
    format!("[{}]", items.join(", "))
}

/// Canonical AGENT.md field order: name, title, description, tools, skills, mcp, model.
fn render_agent_file(
    name: &str,
    title: &str,
    description: &str,
    tools: &[String],
    skills: &[String],
    mcp: &[String],
    model: &str,
    body: &str,
) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {name}\n"));
    out.push_str(&format!("title: {title}\n"));
    out.push_str(&format!("description: {description}\n"));
    out.push_str(&format!("tools: {}\n", render_list(tools)));
    out.push_str(&format!("skills: {}\n", render_list(skills)));
    out.push_str(&format!("mcp: {}\n", render_list(mcp)));
    out.push_str(&format!("model: {model}\n"));
    out.push_str("---\n");
    if body.trim().is_empty() {
        out.push('\n');
    } else {
        out.push_str(&format!("\n{}\n", body.trim()));
    }
    out
}
fn render_frontmatter(meta: &[(String, String)], lists: &HashMap<String, Vec<String>>, body: &str) -> String {
    let mut out = String::from("---\n");
    for (k, v) in meta {
        out.push_str(&format!("{k}: {v}\n"));
    }
    let mut keys: Vec<&String> = lists.keys().collect();
    keys.sort();
    for k in keys {
        let items = &lists[k];
        out.push_str(&format!("{k}: [{}]\n", items.join(", ")));
    }
    out.push_str("---\n");
    if body.trim().is_empty() {
        out.push('\n');
    } else {
        out.push_str(&format!("\n{}\n", body.trim()));
    }
    out
}

fn meta_str(meta: &HashMap<String, Value>, key: &str) -> String {
    meta.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn meta_list(meta: &HashMap<String, Value>, key: &str) -> Vec<String> {
    match meta.get(key) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.clone()],
        _ => Vec::new(),
    }
}

// ─── DTOs ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AgentItem {
    pub name: String,
    pub title: String,
    pub description: String,
    pub tools: Vec<String>,
    pub skills: Vec<String>,
    pub mcp: Vec<String>,
    pub model: String,
    pub body: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SkillItem {
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub body: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PatternItem {
    pub name: String,
    pub description: String,
    pub body: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Overview {
    pub root: String,
    pub root_exists: bool,
    pub agents: Vec<AgentItem>,
    pub skills: Vec<SkillItem>,
    pub patterns: Vec<PatternItem>,
}

#[derive(Debug, Deserialize)]
pub struct AgentBody {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    /// Accepts a single string (legacy UI / `mcp: default`), a comma
    /// string, or a list — mirrors the agent backend (`mcp: [a, b]`).
    #[serde(default, deserialize_with = "de_mcp")]
    pub mcp: Vec<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub body: String,
}

/// String-or-list deserializer for the agent `mcp` field.
fn de_mcp<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    let v = Option::<Value>::deserialize(deserializer)?;
    Ok(match v {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(s)) => split_mcp(&s),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str())
            .flat_map(|s| split_mcp(s))
            .collect(),
        _ => Vec::new(),
    })
}

fn split_mcp(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Backend rule (`agents/loader.py`): each entry `^[a-z0-9]+(-[a-z0-9]+)*$`.
/// Empty selection falls back to `["default"]`.
fn normalize_mcp(raw: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for m in raw.iter().flat_map(|s| split_mcp(s)) {
        let ok = !m.starts_with('-')
            && !m.ends_with('-')
            && m.split('-')
                .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        if !ok {
            return Err(format!("invalid mcp entry {m:?}: use [a-z0-9-]"));
        }
        if !out.contains(&m) {
            out.push(m);
        }
    }
    if out.is_empty() {
        out.push("default".into());
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct SkillBody {
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct PatternBody {
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub body: String,
}

// ─── readers ────────────────────────────────────────────────────────

fn read_agent(dir: &Path) -> AgentItem {
    let name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let path = dir.join("AGENT.md");
    let blank = AgentItem {
        name: name.clone(),
        title: String::new(),
        description: String::new(),
        tools: Vec::new(),
        skills: Vec::new(),
        mcp: Vec::new(),
        model: String::new(),
        body: String::new(),
        error: None,
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            let mut b = blank;
            b.error = Some(format!("unreadable: {e}"));
            return b;
        }
    };
    let (meta, body) = match parse_frontmatter(&text) {
        Ok(x) => x,
        Err(e) => {
            let mut b = blank;
            b.body = text;
            b.error = Some(e);
            return b;
        }
    };
    let fname = meta_str(&meta, "name");
    let mut item = AgentItem {
        title: meta_str(&meta, "title"),
        description: meta_str(&meta, "description"),
        tools: meta_list(&meta, "tools"),
        skills: meta_list(&meta, "skills"),
        mcp: meta_list(&meta, "mcp"),
        model: meta_str(&meta, "model"),
        body,
        error: None,
        ..blank
    };
    if !fname.is_empty() && fname != name {
        item.error = Some(format!("frontmatter name {fname:?} != folder {name:?}"));
    }
    item
}

fn read_skill(dir: &Path) -> SkillItem {
    let name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let path = dir.join("SKILL.md");
    let blank = SkillItem {
        name: name.clone(),
        description: String::new(),
        tools: Vec::new(),
        body: String::new(),
        error: None,
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            let mut b = blank;
            b.error = Some(format!("unreadable: {e}"));
            return b;
        }
    };
    let (meta, body) = match parse_frontmatter(&text) {
        Ok(x) => x,
        Err(e) => {
            let mut b = blank;
            b.body = text;
            b.error = Some(e);
            return b;
        }
    };
    let fname = meta_str(&meta, "name");
    let mut item = SkillItem {
        description: meta_str(&meta, "description"),
        tools: meta_list(&meta, "tools"),
        body,
        error: None,
        ..blank
    };
    if !fname.is_empty() && fname != name {
        item.error = Some(format!("frontmatter name {fname:?} != folder {name:?}"));
    }
    item
}

fn read_pattern(path: &Path) -> PatternItem {
    let name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let blank = PatternItem {
        name: name.clone(),
        description: String::new(),
        body: String::new(),
        error: None,
    };
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            let mut b = blank;
            b.error = Some(format!("unreadable: {e}"));
            return b;
        }
    };
    let (meta, body) = match parse_frontmatter(&text) {
        Ok(x) => x,
        Err(e) => {
            let mut b = blank;
            b.body = text;
            b.error = Some(e);
            return b;
        }
    };
    let fname = meta_str(&meta, "name");
    let mut item = PatternItem {
        description: meta_str(&meta, "description"),
        body,
        error: None,
        ..blank
    };
    if !fname.is_empty() && fname != name {
        item.error = Some(format!("frontmatter name {fname:?} != file {name:?}"));
    }
    item
}

fn list_dirs_sorted(dir: &Path) -> Vec<PathBuf> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && !p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(true))
        .collect();
    out.sort();
    out
}

fn list_patterns_sorted(dir: &Path) -> Vec<PathBuf> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension().map(|x| x == "md").unwrap_or(false)
                && p.file_stem().map(|n| n != "README").unwrap_or(false)
        })
        .collect();
    out.sort();
    out
}

// ─── handlers ───────────────────────────────────────────────────────

pub async fn overview(
    State(state): State<Arc<AppState>>,
    Extension(ident): Extension<crate::auth::AuthIdentity>,
) -> Json<Overview> {
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let can = |s: &str| ident.system || ident.sections.iter().any(|x| x == s);
    let agents_dir = root.join("backend/agents");
    let skills_dir = root.join("backend/skills");
    let patterns_dir = root.join("backend/patterns");
    Json(Overview {
        root: root.to_string_lossy().to_string(),
        root_exists: root.is_dir(),
        agents: if can("agent-agents") {
            list_dirs_sorted(&agents_dir)
                .iter()
                .filter(|p| {
                    p.file_name()
                        .map(|n| n != "AGENT.md" && !n.to_string_lossy().starts_with('.'))
                        .unwrap_or(false)
                })
                .map(|p| read_agent(p))
                .collect()
        } else {
            Vec::new()
        },
        skills: if can("agent-skills") {
            list_dirs_sorted(&skills_dir)
                .iter()
                .map(|p| read_skill(p))
                .collect()
        } else {
            Vec::new()
        },
        patterns: if can("agent-patterns") {
            list_patterns_sorted(&patterns_dir)
                .iter()
                .map(|p| read_pattern(p))
                .collect()
        } else {
            Vec::new()
        },
    })
}

pub async fn known_tools() -> Json<Vec<String>> {
    Json(KNOWN_TOOLS.iter().map(|s| s.to_string()).collect())
}

fn write_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(path, content).map_err(|e| format!("write: {e}"))
}

// ─── agents CRUD ───

pub async fn create_agent(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AgentBody>,
) -> Result<Json<AgentItem>, axum::response::Response> {
    use axum::response::IntoResponse;
    let name = body.name.trim().to_string();
    if !is_valid_name(&name) {
        return Err(super::BadRequest("name must match ^[a-z0-9-]+$ (max 64)".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let dir = jail(&root, &PathBuf::from(format!("backend/agents/{name}")))
        .map_err(|e| super::BadRequest(e).into_response())?;
    if dir.exists() {
        return Err(super::BadRequest(format!("agent {name:?} already exists")).into_response());
    }
    let mcp = normalize_mcp(body.mcp).map_err(|e| super::BadRequest(e).into_response())?;
    let content = render_agent_file(
        &name,
        &body.title.unwrap_or_default(),
        &body.description.unwrap_or_default(),
        &body.tools,
        &body.skills,
        &mcp,
        &body.model.unwrap_or_default(),
        &body.body,
    );
    write_file(&dir.join("AGENT.md"), &content)
        .map_err(|e| super::AppError::msg(e).into_response())?;
    tracing::info!("agent-files: created agent {name}");
    Ok(Json(read_agent(&dir)))
}

pub async fn update_agent(
    State(state): State<Arc<AppState>>,
    AxPath(name): AxPath<String>,
    Json(body): Json<AgentBody>,
) -> Result<Json<AgentItem>, axum::response::Response> {
    use axum::response::IntoResponse;
    if !is_valid_name(&name) {
        return Err(super::BadRequest("invalid name".into()).into_response());
    }
    let new_name = body.name.trim().to_string();
    if !is_valid_name(&new_name) {
        return Err(super::BadRequest("name must match ^[a-z0-9-]+$ (max 64)".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let dir = jail(&root, &PathBuf::from(format!("backend/agents/{name}")))
        .map_err(|e| super::BadRequest(e).into_response())?;
    if !dir.join("AGENT.md").is_file() {
        return Err(super::NotFound.into_response());
    }
    // Rename = move directory (frontmatter name follows).
    let final_dir = if new_name != name {
        let target = jail(&root, &PathBuf::from(format!("backend/agents/{new_name}")))
            .map_err(|e| super::BadRequest(e).into_response())?;
        if target.exists() {
            return Err(super::BadRequest(format!("agent {new_name:?} already exists")).into_response());
        }
        std::fs::rename(&dir, &target).map_err(|e| super::AppError::msg(format!("rename: {e}")).into_response())?;
        tracing::info!("agent-files: renamed agent {name} -> {new_name}");
        target
    } else {
        dir
    };
    let mcp = normalize_mcp(body.mcp).map_err(|e| super::BadRequest(e).into_response())?;
    let content = render_agent_file(
        &new_name,
        &body.title.unwrap_or_default(),
        &body.description.unwrap_or_default(),
        &body.tools,
        &body.skills,
        &mcp,
        &body.model.unwrap_or_default(),
        &body.body,
    );
    write_file(&final_dir.join("AGENT.md"), &content)
        .map_err(|e| super::AppError::msg(e).into_response())?;
    Ok(Json(read_agent(&final_dir)))
}

pub async fn delete_agent(
    State(state): State<Arc<AppState>>,
    AxPath(name): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    if !is_valid_name(&name) {
        return Err(super::BadRequest("invalid name".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let dir = jail(&root, &PathBuf::from(format!("backend/agents/{name}")))
        .map_err(|e| super::BadRequest(e).into_response())?;
    if !dir.join("AGENT.md").is_file() {
        return Err(super::NotFound.into_response());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| super::AppError::msg(format!("delete: {e}")).into_response())?;
    tracing::warn!("agent-files: deleted agent {name}");
    Ok(Json(json!({ "ok": true })))
}

// ─── skills CRUD ───

pub async fn create_skill(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SkillBody>,
) -> Result<Json<SkillItem>, axum::response::Response> {
    use axum::response::IntoResponse;
    let name = body.name.trim().to_string();
    if !is_valid_name(&name) {
        return Err(super::BadRequest("name must match ^[a-z0-9-]+$ (max 64)".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let dir = jail(&root, &PathBuf::from(format!("backend/skills/{name}")))
        .map_err(|e| super::BadRequest(e).into_response())?;
    if dir.exists() {
        return Err(super::BadRequest(format!("skill {name:?} already exists")).into_response());
    }
    let meta = vec![
        ("name".into(), name.clone()),
        ("description".into(), body.description.unwrap_or_default()),
    ];
    let mut lists = HashMap::new();
    lists.insert("tools".to_string(), body.tools);
    let content = render_frontmatter(&meta, &lists, &body.body);
    write_file(&dir.join("SKILL.md"), &content)
        .map_err(|e| super::AppError::msg(e).into_response())?;
    tracing::info!("agent-files: created skill {name}");
    Ok(Json(read_skill(&dir)))
}

pub async fn update_skill(
    State(state): State<Arc<AppState>>,
    AxPath(name): AxPath<String>,
    Json(body): Json<SkillBody>,
) -> Result<Json<SkillItem>, axum::response::Response> {
    use axum::response::IntoResponse;
    if !is_valid_name(&name) {
        return Err(super::BadRequest("invalid name".into()).into_response());
    }
    let new_name = body.name.trim().to_string();
    if !is_valid_name(&new_name) {
        return Err(super::BadRequest("name must match ^[a-z0-9-]+$ (max 64)".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let dir = jail(&root, &PathBuf::from(format!("backend/skills/{name}")))
        .map_err(|e| super::BadRequest(e).into_response())?;
    if !dir.join("SKILL.md").is_file() {
        return Err(super::NotFound.into_response());
    }
    let final_dir = if new_name != name {
        let target = jail(&root, &PathBuf::from(format!("backend/skills/{new_name}")))
            .map_err(|e| super::BadRequest(e).into_response())?;
        if target.exists() {
            return Err(super::BadRequest(format!("skill {new_name:?} already exists")).into_response());
        }
        std::fs::rename(&dir, &target).map_err(|e| super::AppError::msg(format!("rename: {e}")).into_response())?;
        tracing::info!("agent-files: renamed skill {name} -> {new_name}");
        target
    } else {
        dir
    };
    let meta = vec![
        ("name".into(), new_name.clone()),
        ("description".into(), body.description.unwrap_or_default()),
    ];
    let mut lists = HashMap::new();
    lists.insert("tools".to_string(), body.tools);
    let content = render_frontmatter(&meta, &lists, &body.body);
    write_file(&final_dir.join("SKILL.md"), &content)
        .map_err(|e| super::AppError::msg(e).into_response())?;
    Ok(Json(read_skill(&final_dir)))
}

pub async fn delete_skill(
    State(state): State<Arc<AppState>>,
    AxPath(name): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    if !is_valid_name(&name) {
        return Err(super::BadRequest("invalid name".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let dir = jail(&root, &PathBuf::from(format!("backend/skills/{name}")))
        .map_err(|e| super::BadRequest(e).into_response())?;
    if !dir.join("SKILL.md").is_file() {
        return Err(super::NotFound.into_response());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| super::AppError::msg(format!("delete: {e}")).into_response())?;
    tracing::warn!("agent-files: deleted skill {name}");
    Ok(Json(json!({ "ok": true })))
}

// ─── patterns CRUD (single .md files) ───

pub async fn create_pattern(
    State(state): State<Arc<AppState>>,
    Json(body): Json<PatternBody>,
) -> Result<Json<PatternItem>, axum::response::Response> {
    use axum::response::IntoResponse;
    let name = body.name.trim().to_string();
    if !is_valid_name(&name) {
        return Err(super::BadRequest("name must match ^[a-z0-9-]+$ (max 64)".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = jail(&root, &PathBuf::from(format!("backend/patterns/{name}.md")))
        .map_err(|e| super::BadRequest(e).into_response())?;
    if path.exists() {
        return Err(super::BadRequest(format!("pattern {name:?} already exists")).into_response());
    }
    let meta = vec![
        ("name".into(), name.clone()),
        ("description".into(), body.description.unwrap_or_default()),
    ];
    let content = render_frontmatter(&meta, &HashMap::new(), &body.body);
    write_file(&path, &content).map_err(|e| super::AppError::msg(e).into_response())?;
    tracing::info!("agent-files: created pattern {name}");
    Ok(Json(read_pattern(&path)))
}

pub async fn update_pattern(
    State(state): State<Arc<AppState>>,
    AxPath(name): AxPath<String>,
    Json(body): Json<PatternBody>,
) -> Result<Json<PatternItem>, axum::response::Response> {
    use axum::response::IntoResponse;
    if !is_valid_name(&name) {
        return Err(super::BadRequest("invalid name".into()).into_response());
    }
    let new_name = body.name.trim().to_string();
    if !is_valid_name(&new_name) {
        return Err(super::BadRequest("name must match ^[a-z0-9-]+$ (max 64)".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = jail(&root, &PathBuf::from(format!("backend/patterns/{name}.md")))
        .map_err(|e| super::BadRequest(e).into_response())?;
    if !path.is_file() {
        return Err(super::NotFound.into_response());
    }
    let final_path = if new_name != name {
        let target = jail(&root, &PathBuf::from(format!("backend/patterns/{new_name}.md")))
            .map_err(|e| super::BadRequest(e).into_response())?;
        if target.exists() {
            return Err(super::BadRequest(format!("pattern {new_name:?} already exists")).into_response());
        }
        std::fs::rename(&path, &target).map_err(|e| super::AppError::msg(format!("rename: {e}")).into_response())?;
        tracing::info!("agent-files: renamed pattern {name} -> {new_name}");
        target
    } else {
        path
    };
    let meta = vec![
        ("name".into(), new_name.clone()),
        ("description".into(), body.description.unwrap_or_default()),
    ];
    let content = render_frontmatter(&meta, &HashMap::new(), &body.body);
    write_file(&final_path, &content).map_err(|e| super::AppError::msg(e).into_response())?;
    Ok(Json(read_pattern(&final_path)))
}

pub async fn delete_pattern(
    State(state): State<Arc<AppState>>,
    AxPath(name): AxPath<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    if !is_valid_name(&name) {
        return Err(super::BadRequest("invalid name".into()).into_response());
    }
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let path = jail(&root, &PathBuf::from(format!("backend/patterns/{name}.md")))
        .map_err(|e| super::BadRequest(e).into_response())?;
    if !path.is_file() {
        return Err(super::NotFound.into_response());
    }
    std::fs::remove_file(&path).map_err(|e| super::AppError::msg(format!("delete: {e}")).into_response())?;
    tracing::warn!("agent-files: deleted pattern {name}");
    Ok(Json(json!({ "ok": true })))
}
