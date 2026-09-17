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

#[derive(Debug, Deserialize)]
pub struct ExportQuery {
    pub format: Option<String>,
    pub base: Option<String>,
    pub token: Option<String>,
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

    let headers_json = q
        .token
        .map(|t| json!({ "Authorization": format!("Bearer {t}") }));
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
