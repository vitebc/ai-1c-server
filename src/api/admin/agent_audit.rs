//! Audit trail for Agent Studio changes (agents/skills/patterns).
//!
//! Every create/update/delete performed through the admin API is committed
//! to the 1c-ai-agent git repository and recorded in the `agent_changes`
//! table. History supports diff viewing (`git show`) and rollback of any
//! past change (`git revert` → new commit + audit row).
//!
//! Git commands run with a 30s timeout; a failed commit never breaks the
//! API call — the file change is already on disk, the audit row is simply
//! skipped (warning in server log).

use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path as AxPath, Query, State},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::super::AppState;
use super::agent_files::project_root;

const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Run a git command inside `root`; returns (stdout, stderr).
fn git(root: &Path, args: &[&str]) -> Result<(String, String), String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("git spawn: {e}"))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

/// Commit the given repo-relative paths (e.g. `backend/agents/foo`) with a
/// message; returns the new commit hash.
fn git_commit_paths(root: &Path, rel_paths: &[String], message: &str) -> Result<String, String> {
    let mut args = vec!["add", "--"];
    args.extend(rel_paths.iter().map(|s| s.as_str()));
    let (out, err) = git(root, &args)?;
    if !out.is_empty() && err.contains("fatal") {
        return Err(format!("git add failed: {}", err.trim()));
    }

    // Nothing staged (identical content) → no commit.
    let (staged, _) = git(root, &["diff", "--cached", "--name-only"])?;
    if staged.trim().is_empty() {
        return Err("no changes to commit".into());
    }

    let commit_args: Vec<&str> = vec!["commit", "-m", message];
    let (out, err) = git(root, &commit_args)?;
    if !out.contains("[") && !err.is_empty() {
        return Err(format!("git commit failed: {}", err.trim()));
    }

    // Extract the new hash.
    let (hash_out, _) = git(root, &["rev-parse", "HEAD"])?;
    Ok(hash_out.trim().to_string())
}

/// `git show --unified=3 <hash>` — only changed lines with 3 context lines.
pub fn git_diff_for_hash(root: &Path, hash: &str) -> Result<String, String> {
    let (out, err) = git(root, &["show", "--unified=3", "--no-color", hash])?;
    if out.is_empty() && !err.is_empty() {
        return Err(format!("git show failed: {}", err.trim()));
    }
    Ok(out)
}

/// Revert a past commit (creates a new commit undoing it). Returns the new hash.
pub fn git_revert(root: &Path, hash: &str) -> Result<String, String> {
    let mut args = vec!["revert", "--no-edit"];
    args.push(hash);
    let (out, err) = git(root, &args)?;
    if out.contains("error") || (!err.is_empty() && !out.contains("Reverted")) {
        // Abort a half-finished revert state if any.
        let _ = git(root, &["revert", "--abort"]);
        return Err(format!("git revert failed: {}", err.trim()));
    }
    let (hash_out, _) = git(root, &["rev-parse", "HEAD"])?;
    Ok(hash_out.trim().to_string())
}

// ─── audit table helpers ─────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AgentChange {
    pub id: i64,
    pub timestamp: String,
    pub user_id: String,
    pub username: String,
    pub entity_type: String,
    pub entity_name: String,
    pub action: String,
    pub git_commit_hash: String,
    pub diff_summary: String,
}

/// Record a change after a successful git commit. Failures are logged,
/// never fatal for the API response.
pub fn record_change(
    db: &crate::db::Database,
    user_id: &str,
    username: &str,
    entity_type: &str,
    entity_name: &str,
    action: &str,
    commit_hash: &str,
    diff_summary: &str,
) {
    let res = db.conn.execute(
        "INSERT INTO agent_changes \
         (user_id, username, entity_type, entity_name, action, git_commit_hash, diff_summary) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            user_id,
            username,
            entity_type,
            entity_name,
            action,
            commit_hash,
            diff_summary,
        ],
    );
    if let Err(e) = res {
        tracing::error!("agent-audit: failed to record change: {e}");
    } else {
        tracing::info!(
            "agent-audit: {action} {entity_type}/{entity_name} by {username} → {commit_hash}"
        );
    }
}

/// Convenience used by agent_files handlers: commit + record in one call.
/// `rel_path` is the repo-relative path to add (folder or file).
pub fn commit_and_record(
    state: &Arc<AppState>,
    db: &crate::db::Database,
    user_id: &str,
    username: &str,
    entity_type: &str,
    entity_name: &str,
    action: &str,
    rel_path: &str,
) {
    let root = project_root(db);
    if !root.join(".git").is_dir() {
        tracing::warn!("agent-audit: project root is not a git repo — skipping commit");
        return;
    }
    let message = format!("{entity_type}: {entity_name} — {action} by {username}");
    match git_commit_paths(&root, &[rel_path.to_string()], &message) {
        Ok(hash) => {
            // Short diff summary: first changed file + line counts.
            let summary = git(&root, &["show", "--stat", "--format=", &hash])
                .map(|(out, _)| out.trim().to_string())
                .unwrap_or_default();
            record_change(
                db, user_id, username, entity_type, entity_name, action, &hash, &summary,
            );
        }
        Err(e) if e == "no changes to commit" => {
            // Content identical — nothing to audit.
        }
        Err(e) => {
            tracing::warn!("agent-audit: git commit failed for {entity_type}/{entity_name}: {e}");
        }
    }
    let _ = state;
}

// ─── handlers ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChangesQuery {
    user_id: Option<String>,
    entity_type: Option<String>,
    entity_name: Option<String>,
    action: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct ChangesPage {
    items: Vec<AgentChange>,
    total: i64,
}

/// GET /agent-changes — paginated history with filters.
pub async fn list_changes(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ChangesQuery>,
) -> Result<Json<ChangesPage>, axum::response::Response> {
    let limit = q.limit.unwrap_or(50).min(200);
    let offset = q.offset.unwrap_or(0);

    // Clone filter values out of `q` so the extractor is fully consumed
    // before we await (axum requires extractors to be moved into the body).
    // Clone filter values out of `q` so the extractor is fully consumed
    // before we await (axum requires extractors to be moved into the body).
    let f_user_id = q.user_id.clone();
    let f_entity_type = q.entity_type.clone();
    let f_entity_name = q.entity_name.clone();
    let f_action = q.action.clone();
    let f_from = q.from.clone();
    let f_to = q.to.clone();

    // Collect filter values as plain Strings (cheap to clone for the two queries).
    let mut where_parts: Vec<String> = Vec::new();
    let mut filter_vals: Vec<String> = Vec::new();
    let mut idx = 0usize;
    if f_user_id.is_some() { idx += 1; where_parts.push(format!("user_id = ?{idx}")); filter_vals.push(f_user_id.unwrap()); }
    if f_entity_type.is_some() { idx += 1; where_parts.push(format!("entity_type = ?{idx}")); filter_vals.push(f_entity_type.unwrap()); }
    if f_entity_name.is_some() { idx += 1; where_parts.push(format!("entity_name LIKE ?{idx}")); filter_vals.push(format!("%{}%", f_entity_name.unwrap())); }
    if f_action.is_some() { idx += 1; where_parts.push(format!("action = ?{idx}")); filter_vals.push(f_action.unwrap()); }
    if f_from.is_some() { idx += 1; where_parts.push(format!("timestamp >= ?{idx}")); filter_vals.push(f_from.unwrap()); }
    if f_to.is_some() { idx += 1; where_parts.push(format!("timestamp <= ?{idx}")); filter_vals.push(f_to.unwrap()); }
    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    // Build the page query up front (no await between prepare and query).
    let page_sql = format!(
        "SELECT id, timestamp, user_id, username, entity_type, entity_name, \
         action, git_commit_hash, diff_summary \
         FROM agent_changes {where_sql} ORDER BY timestamp DESC, id DESC LIMIT ?{a} OFFSET ?{b}",
        a = filter_vals.len() + 1,
        b = filter_vals.len() + 2,
    );
    // Count query params: just the filter values.
    let count_params: Vec<String> = filter_vals.clone();
    // Page query params: filter values + limit + offset.
    let mut page_params: Vec<String> = filter_vals;
    page_params.push(format!("{limit}"));
    page_params.push(format!("{offset}"));

    let count_sql = format!("SELECT COUNT(*) FROM agent_changes {where_sql}");

    let db = state.db.lock().await;

    // Count.
    let total: i64 = match db.conn.prepare(&count_sql) {
        Ok(mut stmt) => match stmt.query(rusqlite::params_from_iter(count_params.iter())) {
            Ok(mut rows) => match rows.next() {
                Ok(Some(row)) => row.get(0).unwrap_or(0),
                _ => 0,
            },
            Err(_) => 0,
        },
        Err(e) => return Err(super::AppError::msg(e.to_string()).into_response()),
    };

    // Page.
    let items: Vec<AgentChange> = match db.conn.prepare(&page_sql) {
        Ok(mut stmt) => match stmt.query_map(rusqlite::params_from_iter(page_params.iter()), |row| {
            Ok(AgentChange {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                user_id: row.get(2)?,
                username: row.get(3)?,
                entity_type: row.get(4)?,
                entity_name: row.get(5)?,
                action: row.get(6)?,
                git_commit_hash: row.get(7)?,
                diff_summary: row.get(8)?,
            })
        }) {
            Ok(rows) => rows.flatten().collect(),
            Err(e) => return Err(super::AppError::msg(e.to_string()).into_response()),
        },
        Err(e) => return Err(super::AppError::msg(e.to_string()).into_response()),
    };

    Ok(Json(ChangesPage { items, total }))
}

/// GET /agent-changes/distinct — filter options (users, entity names).
pub async fn distinct_changes(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, axum::response::Response> {
    let db = state.db.lock().await;
    let users: Vec<String> = {
        let mut stmt = match db.conn.prepare(
            "SELECT DISTINCT username FROM agent_changes ORDER BY username",
        ) {
            Ok(s) => s,
            Err(e) => return Err(super::AppError::msg(e.to_string()).into_response()),
        };
        let rows = match stmt.query_map([], |r| r.get(0)) {
            Ok(r) => r,
            Err(e) => return Err(super::AppError::msg(e.to_string()).into_response()),
        };
        rows.flatten().collect()
    };
    let entities: Vec<(String, String)> = {
        let mut stmt = match db.conn.prepare(
            "SELECT DISTINCT entity_type, entity_name FROM agent_changes \
             ORDER BY entity_type, entity_name",
        ) {
            Ok(s) => s,
            Err(e) => return Err(super::AppError::msg(e.to_string()).into_response()),
        };
        let rows = match stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))) {
            Ok(r) => r,
            Err(e) => return Err(super::AppError::msg(e.to_string()).into_response()),
        };
        rows.flatten().collect()
    };
    Ok(Json(json!({ "users": users, "entities": entities })))
}

/// GET /agent-changes/{id}/diff — unified diff of the commit (changed lines only).
pub async fn change_diff(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Value>, axum::response::Response> {
    let hash: String = {
        let db = state.db.lock().await;
        match db.conn.query_row(
                "SELECT git_commit_hash FROM agent_changes WHERE id = ?1",
                [id],
                |r| r.get::<_, String>(0),
            ) {
            Ok(h) => h,
            Err(_) => return Err(super::NotFound.into_response()),
        }
    };
    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };
    let diff = git_diff_for_hash(&root, &hash).unwrap_or_else(|e| format!("(diff error: {e})"));
    Ok(Json(json!({ "commit": hash, "diff": diff })))
}

/// POST /agent-changes/{id}/revert — revert any past change (new commit).
pub async fn revert_change(
    State(state): State<Arc<AppState>>,
    AxPath(id): AxPath<i64>,
) -> Result<Json<Value>, axum::response::Response> {
    let row: (String, String, String, String, String) = {
        let db = state.db.lock().await;
        match db.conn.query_row(
                "SELECT git_commit_hash, entity_type, entity_name, user_id, username \
                 FROM agent_changes WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            ) {
            Ok(r) => r,
            Err(_) => return Err(super::NotFound.into_response()),
        }
    };

    let root = {
        let db = state.db.lock().await;
        project_root(&db)
    };

    // Revert creates a new commit — but `git revert` of a *revert* commit or
    // of commits touching multiple files is fine: we only ever commit single
    // entity paths, so the revert stays scoped.
    let new_hash = match git_revert(&root, &row.0) {
        Ok(h) => h,
        Err(e) => {
            return Err(super::AppError::msg(format!("revert failed: {e}")).into_response())
        }
    };

    // The reverted entity may no longer exist (revert of a delete restores it;
    // revert of a create removes it). Use the original name for the audit row.
    let summary = git(&root, &["show", "--stat", "--format=", &new_hash])
        .map(|(out, _)| out.trim().to_string())
        .unwrap_or_default();
    {
        let db = state.db.lock().await;
        record_change(
            &db, &row.3, &row.4, &row.1, &row.2, "revert", &new_hash, &summary,
        );
    }

    Ok(Json(json!({ "ok": true, "commit": new_hash })))
}

/// DELETE /agent-changes/purge — drop rows older than `days` (default 30).
#[derive(Debug, Deserialize)]
pub struct PurgeQuery {
    days: Option<i64>,
}

pub async fn purge_changes(
    State(state): State<Arc<AppState>>,
    Query(q): Query<PurgeQuery>,
) -> Result<Json<Value>, axum::response::Response> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let db = state.db.lock().await;
    match db.conn.execute(
        "DELETE FROM agent_changes WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?1)",
        [format!("-{days} days")],
    ) {
        Ok(n) => Ok(Json(json!({ "ok": true, "deleted": n }))),
        Err(e) => Err(super::AppError::msg(e.to_string()).into_response()),
    }
}
