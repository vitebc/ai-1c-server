use std::sync::Arc;
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};

use super::super::AppState;

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
) -> Result<Json<McpServerRow>, super::AppError> {
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
    )?;
    drop(db);
    get_by_id(State(state), Path(id)).await.map_err(Into::into)
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateMcpServer>,
) -> Result<Json<McpServerRow>, super::AppError> {
    let db = state.db.lock().await;
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
    ).map_err(|_| super::NotFound)?;

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
    let changes = db.conn.execute("DELETE FROM mcp_servers WHERE id = ?1", [&id])?;
    if changes == 0 {
        return Err(super::NotFound.into());
    }
    Ok(Json(()))
}
