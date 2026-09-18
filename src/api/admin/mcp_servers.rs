use std::sync::Arc;
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::super::AppState;
use crate::mcp::McpServerConfig;

#[derive(Debug, Serialize, Deserialize)]
pub struct McpServerRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub server_type: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<String>,
    pub env: Option<String>,
    pub url: Option<String>,
    pub enabled: bool,
    pub config: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateMcpServer {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub server_type: String,
    pub transport: Option<String>,
    pub command: Option<String>,
    pub args: Option<String>,
    pub env: Option<String>,
    pub url: Option<String>,
    pub enabled: Option<bool>,
    pub config: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMcpServer {
    pub name: Option<String>,
    pub description: Option<String>,
    pub server_type: Option<String>,
    pub transport: Option<String>,
    pub command: Option<String>,
    pub args: Option<String>,
    pub env: Option<String>,
    pub url: Option<String>,
    pub enabled: Option<bool>,
    pub config: Option<String>,
}

/// Validate `args` (JSON array of strings) and `env` (JSON object) shapes.
/// Empty/absent values are OK (treated as unset). Returns 400 on mismatch.
fn validate_args_env(args: Option<&str>, env: Option<&str>) -> Result<(), super::BadRequest> {
    if let Some(a) = args.map(str::trim).filter(|s| !s.is_empty()) {
        serde_json::from_str::<Vec<String>>(a)
            .map(|_| ())
            .map_err(|e| {
                super::BadRequest(format!("Invalid 'args' JSON (expected array of strings): {e}"))
            })?;
    }
    if let Some(e) = env.map(str::trim).filter(|s| !s.is_empty()) {
        serde_json::from_str::<std::collections::HashMap<String, String>>(e)
            .map(|_| ())
            .map_err(|e| {
                super::BadRequest(format!("Invalid 'env' JSON (expected object of strings): {e}"))
            })?;
    }
    Ok(())
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<McpServerRow>> {
    let db = state.db.lock().await;
    let mut stmt = db.conn.prepare(
        "SELECT id, name, description, server_type, transport, command, args, env, url, enabled, config, created_at, updated_at
         FROM mcp_servers ORDER BY name"
    ).unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(McpServerRow {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            server_type: row.get(3)?,
            transport: row.get(4)?,
            command: row.get(5)?,
            args: row.get(6)?,
            env: row.get(7)?,
            url: row.get(8)?,
            enabled: row.get::<_, i32>(9)? != 0,
            config: row.get(10)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    }).unwrap();
    Json(rows.flatten().collect())
}

pub async fn get_by_id(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<McpServerRow>, super::NotFound> {
    let db = state.db.lock().await;
    let row = db.conn.query_row(
        "SELECT id, name, description, server_type, transport, command, args, env, url, enabled, config, created_at, updated_at
         FROM mcp_servers WHERE id = ?1",
        [&id],
        |row| {
            Ok(McpServerRow {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                server_type: row.get(3)?,
                transport: row.get(4)?,
                command: row.get(5)?,
                args: row.get(6)?,
                env: row.get(7)?,
                url: row.get(8)?,
                enabled: row.get::<_, i32>(9)? != 0,
                config: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        },
    ).map_err(|_| super::NotFound)?;
    Ok(Json(row))
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateMcpServer>,
) -> Result<Json<McpServerRow>, axum::response::Response> {
    use axum::response::IntoResponse;
    validate_args_env(body.args.as_deref(), body.env.as_deref())
        .map_err(IntoResponse::into_response)?;
    let id = body.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let db = state.db.lock().await;
    db.conn.execute(
        "INSERT INTO mcp_servers (id, name, description, server_type, transport, command, args, env, url, enabled, config)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            id,
            body.name,
            body.description,
            body.server_type,
            body.transport.unwrap_or_else(|| "stdio".into()),
            body.command,
            body.args,
            body.env,
            body.url,
            body.enabled.unwrap_or(true) as i32,
            body.config,
        ],
    ).map_err(|e| super::AppError::from(e).into_response())?;
    drop(db);
    // Hot-reload: (re)start the session from the new row.
    sync_server(&state, &id).await;
    get_by_id(State(state), Path(id)).await.map_err(|e| super::AppError::from(e).into_response())
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateMcpServer>,
) -> Result<Json<McpServerRow>, axum::response::Response> {
    use axum::response::IntoResponse;
    validate_args_env(body.args.as_deref(), body.env.as_deref())
        .map_err(IntoResponse::into_response)?;    let db = state.db.lock().await;
    let existing: McpServerRow = db.conn.query_row(
        "SELECT id, name, description, server_type, transport, command, args, env, url, enabled, config, created_at, updated_at
         FROM mcp_servers WHERE id = ?1",
        [&id],
        |row| {
            Ok(McpServerRow {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                server_type: row.get(3)?,
                transport: row.get(4)?,
                command: row.get(5)?,
                args: row.get(6)?,
                env: row.get(7)?,
                url: row.get(8)?,
                enabled: row.get::<_, i32>(9)? != 0,
                config: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        },
    ).map_err(|_| super::NotFound.into_response())?;

    db.conn.execute(
        "UPDATE mcp_servers SET
            name = ?1, description = ?2, server_type = ?3, transport = ?4,
            command = ?5, args = ?6, env = ?7, url = ?8, enabled = ?9, config = ?10,
            updated_at = datetime('now')
         WHERE id = ?11",
        rusqlite::params![
            body.name.as_deref().unwrap_or(&existing.name),
            body.description.or(existing.description),
            body.server_type.as_deref().unwrap_or(&existing.server_type),
            body.transport.as_deref().unwrap_or(&existing.transport),
            body.command.or(existing.command),
            body.args.or(existing.args),
            body.env.or(existing.env),
            body.url.or(existing.url),
            body.enabled.unwrap_or(existing.enabled) as i32,
            body.config.or(existing.config),
            id.clone(),
        ],
    ).map_err(|e| super::AppError::from(e).into_response())?;
    drop(db);
    // Hot-reload: restart the session with the updated row.
    sync_server(&state, &id).await;
    get_by_id(State(state), Path(id)).await.map_err(|e| super::AppError::from(e).into_response())
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, super::AppError> {
    let db = state.db.lock().await;
    let changes = db.conn.execute("DELETE FROM mcp_servers WHERE id = ?1", [&id])?;
    if changes == 0 {
        return Err(super::NotFound.into());
    }
    drop(db);
    // Hot-reload: stop the running session (no restart needed).
    state.mcp.stop_server(&id).await;
    Ok(Json(()))
}

/// (Re)start the session for `id` from the current DB row.
/// Disabled or missing rows only stop the session.
pub(super) async fn sync_server(state: &Arc<AppState>, id: &str) {
    state.mcp.stop_server(id).await;
    let cfg: Option<McpServerConfig> = {
        let db = state.db.lock().await;
        db.conn
            .query_row(
                "SELECT id, name, description, server_type, transport, command, args, env, url, enabled, config
                 FROM mcp_servers WHERE id = ?1",
                [id],
                |row| {
                    Ok(McpServerConfig {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        server_type: row.get(3)?,
                        transport: row.get(4)?,
                        command: row.get(5)?,
                        args: row.get(6)?,
                        env: row.get(7)?,
                        url: row.get(8)?,
                        enabled: row.get::<_, i32>(9)? != 0,
                        config: row.get(10)?,
                    })
                },
            )
            .ok()
    };
    match cfg {
        Some(c) if c.enabled => {
            if let Err(e) = state.mcp.start_server(&c).await {
                tracing::error!("hot-reload: failed to start MCP server '{id}': {e}");
            }
        }
        _ => tracing::info!("hot-reload: MCP server '{id}' stopped (disabled or removed)"),
    }
}

/// POST /api/admin/mcp-servers/{id}/restart — hot-restart without server reboot.
pub async fn restart(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, super::AppError> {
    let exists: bool = {
        let db = state.db.lock().await;
        db.conn
            .query_row(
                "SELECT 1 FROM mcp_servers WHERE id = ?1",
                [&id],
                |_| Ok(()),
            )
            .is_ok()
    };
    if !exists {
        return Err(super::NotFound.into());
    }
    sync_server(&state, &id).await;
    Ok(Json(json!({ "id": id, "running": state.mcp.is_running(&id).await })))
}

/// GET /api/admin/mcp-servers/{id}/stats — call the `stats` tool on a running
/// session (used for search index stats). Returns the tool text output.
pub async fn stats(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    // Accept id or name.
    let sid: Option<String> = {
        let db = state.db.lock().await;
        db.conn
            .query_row(
                "SELECT id FROM mcp_servers WHERE id = ?1 OR name = ?1",
                [&id],
                |row| row.get::<_, String>(0),
            )
            .ok()
    };
    let sid = match sid {
        Some(s) => s,
        None => return Err(super::NotFound.into_response()),
    };
    match state.mcp.call_tool(&sid, "stats", json!({})).await {
        Ok(result) => {
            let text = result
                .get("content")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|b| b.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            Ok(Json(json!({ "id": sid, "text": text, "raw": result })))
        }
        Err(e) => Err((axum::http::StatusCode::BAD_GATEWAY, e.to_string()).into_response()),
    }
}

/// FNV hash identical to `mcp-1c-search` `fnv_hash` (multiply-then-xor).
/// The binary stores per-root indexes as `{INDEX_DIR}/{hash:016x}.db`.
fn search_index_hash(path: &str) -> u64 {
    let mut hash: u64 = 14695981039346656037;
    for byte in path.bytes() {
        hash = hash.wrapping_mul(1099511628211);
        hash ^= byte as u64;
    }
    hash
}

/// Collect indexed source roots for a search row: from its env
/// (`ONEC_CONFIG_PROFILES_JSON`) or, as fallback, from the linked
/// config profile (`mcp_servers.config`).
fn search_roots(
    db: &crate::db::Database,
    env: Option<&str>,
    profile_id: Option<&str>,
) -> (Vec<String>, Option<String>) {
    if let Some(e) = env.and_then(|s| serde_json::from_str::<Value>(s).ok()) {
        let index_dir = e
            .get("MINI_AI_1C_SEARCH_INDEX_DIR")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let mut roots = Vec::new();
        if let Some(profiles) = e.get("ONEC_CONFIG_PROFILES_JSON").and_then(|v| v.as_str()) {
            if let Ok(arr) = serde_json::from_str::<Vec<Value>>(profiles) {
                for p in &arr {
                    if let Some(m) = p.get("main_path").and_then(|v| v.as_str()) {
                        if !m.trim().is_empty() {
                            roots.push(m.trim().to_string());
                        }
                    }
                    if let Some(exts) = p.get("extensions").and_then(|v| v.as_array()) {
                        for x in exts {
                            if let Some(xp) = x.get("path").and_then(|v| v.as_str()) {
                                if !xp.trim().is_empty() {
                                    roots.push(xp.trim().to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
        if !roots.is_empty() {
            return (roots, index_dir);
        }
    }
    // Fallback: linked config profile + its extensions.
    if let Some(pid) = profile_id {
        let profiles = super::configs::load_all(db);
        if let Some(main) = profiles.iter().find(|p| p.id == pid) {
            let mut roots = vec![main.path.clone()];
            roots.extend(
                profiles
                    .iter()
                    .filter(|p| p.parent_id.as_deref() == Some(pid))
                    .map(|p| p.path.clone()),
            );
            let index_dir = db
                .conn
                .query_row(
                    "SELECT value FROM server_settings WHERE key = 'search_index_dir'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            return (roots, index_dir);
        }
    }
    (Vec::new(), None)
}

/// POST /api/admin/mcp-servers/{id}/reindex — full search reindex:
/// deletes per-root SQLite index files and restarts the session.
/// The binary rebuilds the index from scratch in the background.
pub async fn reindex(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, axum::response::Response> {
    use axum::response::IntoResponse;
    let row: Option<(String, Option<String>, Option<String>, Option<String>)> = {
        let db = state.db.lock().await;
        db.conn
            .query_row(
                "SELECT id, env, config, command FROM mcp_servers WHERE id = ?1 OR name = ?1",
                [&id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .ok()
    };
    let (sid, env, profile_id, command) = match row {
        Some(r) => r,
        None => return Err(super::NotFound.into_response()),
    };
    if command.as_deref().is_none_or(|c| !c.contains("mcp-1c-search")) {
        return Err(super::BadRequest("reindex is only supported for mcp-1c-search rows".into())
            .into_response());
    }
    let (roots, index_dir) = {
        let db = state.db.lock().await;
        search_roots(&db, env.as_deref(), profile_id.as_deref())
    };
    if roots.is_empty() {
        return Err(super::BadRequest("no indexed roots found for this server".into())
            .into_response());
    }
    let index_dir = index_dir.unwrap_or_else(|| {
        format!(
            "{}/search-index",
            state.data_dir.trim_end_matches('/')
        )
    });

    // Stop the session first so no process holds the index files.
    state.mcp.stop_server(&sid).await;

    let mut deleted: Vec<String> = Vec::new();
    for root in &roots {
        let base = std::path::Path::new(&index_dir)
            .join(format!("{:016x}.db", search_index_hash(root)));
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let p = format!("{}{}", base.display(), suffix);
            match std::fs::remove_file(&p) {
                Ok(()) => deleted.push(p),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    tracing::warn!("reindex: cannot remove '{p}': {e}");
                }
            }
        }
    }

    sync_server(&state, &sid).await;
    let running = state.mcp.is_running(&sid).await;
    Ok(Json(json!({
        "id": sid,
        "roots": roots,
        "index_dir": index_dir,
        "deleted": deleted,
        "running": running,
    })))
}

#[derive(Debug, Deserialize)]
pub struct ExportQuery {
    pub format: Option<String>,
    pub base: Option<String>,
    /// Explicit token override. When absent, the stored token is embedded
    /// automatically if auth is enforced; pass `notoken=1` to skip it.
    pub token: Option<String>,
    pub notoken: Option<String>,
}

/// GET /api/admin/mcp-servers/export?format=opencode|opencode-legacy|claude|cursor
/// Returns a ready-to-paste MCP client config snippet.
pub async fn export(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<ExportQuery>,
) -> Json<Value> {
    let base = q.base.unwrap_or_else(|| {
        headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .map(|h| format!("http://{h}"))
            .unwrap_or_else(|| "http://localhost:9224".into())
    });
    let agg_url = format!("{base}/api/mcp-aggregated/mcp");

    let servers: Vec<(String, String)> = {
        let db = state.db.lock().await;
        let mut stmt = db
            .conn
            .prepare("SELECT id, name FROM mcp_servers WHERE enabled = 1 ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .flatten()
        .collect()
    };

    let mut entries: Vec<(String, String)> = vec![("ai-1c-all".into(), agg_url.clone())];
    for (sid, name) in &servers {
        let key = format!("ai-1c-{}", crate::api::mcp_http::tool_prefix(name));
        entries.push((key, format!("{base}/api/mcp/{sid}/mcp")));
    }

    let headers_json = {
        let explicit = q.token.clone().filter(|t| !t.trim().is_empty());
        let skip = matches!(
            q.notoken.as_deref().map(str::trim),
            Some("1") | Some("true") | Some("yes")
        );
        let stored = if skip {
            None
        } else {
            let db = state.db.lock().await;
            if crate::auth::is_auth_required(&db) {
                crate::auth::current_token(&db)
            } else {
                None
            }
        };
        explicit
            .or(stored)
            .map(|t| json!({ "Authorization": format!("Bearer {t}") }))
    };
    let with_headers = |mut obj: serde_json::Map<String, Value>| -> Value {
        if let Some(h) = &headers_json {
            obj.insert("headers".into(), h.clone());
        }
        Value::Object(obj)
    };

    let format = q.format.as_deref().unwrap_or("opencode");
    let servers_obj: serde_json::Map<String, Value> = entries
        .iter()
        .map(|(name, url)| {
            let entry = match format {
                // sst/opencode: "mcp": { name: { type: "remote", url } }
                "opencode" => with_headers(
                    [
                        ("type".into(), json!("remote")),
                        ("url".into(), json!(url)),
                        ("enabled".into(), json!(true)),
                    ]
                    .into_iter()
                    .collect(),
                ),
                // legacy Go opencode + generic SSE clients
                "opencode-legacy" | "sse" => with_headers(
                    [("type".into(), json!("sse")), ("url".into(), json!(url))]
                        .into_iter()
                        .collect(),
                ),
                // Claude Code: claude mcp add --transport http
                "claude" => with_headers(
                    [("type".into(), json!("http")), ("url".into(), json!(url))]
                        .into_iter()
                        .collect(),
                ),
                // Cursor mcp.json / generic Streamable HTTP
                _ => with_headers(
                    [("url".into(), json!(url))].into_iter().collect(),
                ),
            };
            (name.clone(), entry)
        })
        .collect();

    let key = if format == "opencode" { "mcp" } else { "mcpServers" };
    Json(json!({ key: servers_obj }))
}
