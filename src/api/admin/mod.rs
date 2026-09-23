use std::sync::Arc;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::Level;

use super::AppState;
use crate::log_buffer::LogEntry;

mod bsl_ls;
mod client_versions;
mod clients;
mod configs;
mod fs;
mod mcp_servers;
pub(crate) mod search_sync;
mod settings;
pub mod skills;
pub mod agent_backend;
pub mod agent_files;
mod users;

#[derive(Debug)]
pub struct NotFound;

impl IntoResponse for NotFound {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::NOT_FOUND, "Not found").into_response()
    }
}

#[derive(Debug)]
pub struct AppError(Box<dyn std::error::Error>);

impl<T: Into<Box<dyn std::error::Error>>> From<T> for AppError {
    fn from(err: T) -> Self {
        Self(err.into())
    }
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        Self(s.into().into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        tracing::error!("Admin API error: {}", self.0);
        (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()).into_response()
    }
}

impl From<NotFound> for AppError {
    fn from(_: NotFound) -> Self {
        AppError("Not found".into())
    }
}

#[derive(Debug)]
pub struct BadRequest(pub String);

impl IntoResponse for BadRequest {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::BAD_REQUEST, self.0).into_response()
    }
}

impl From<BadRequest> for AppError {
    fn from(e: BadRequest) -> Self {
        AppError(e.0.into())
    }
}

#[derive(Debug, Serialize)]
struct McpServerStatus {
    id: String,
    name: String,
    status: String,
}

async fn status(State(state): State<Arc<AppState>>) -> Json<Vec<McpServerStatus>> {
    let rows: Vec<(String, String)> = {
        let db = state.db.lock().await;
        let mut stmt = db.conn.prepare(
            "SELECT id, name FROM mcp_servers WHERE enabled = 1 ORDER BY name"
        ).unwrap();
        stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).unwrap().flatten().collect()
    };
    let mut out = Vec::new();
    for (id, name) in rows {
        let live = state.mcp.is_running(&id).await;
        out.push(McpServerStatus {
            id,
            name,
            status: if live { "running".into() } else { "stopped".into() },
        });
    }
    Json(out)
}

#[derive(Debug, Deserialize)]
struct LogsQuery {
    level: Option<String>,
    limit: Option<usize>,
    search: Option<String>,
}

fn parse_level(s: Option<&str>) -> Option<Level> {
    match s?.to_uppercase().as_str() {
        "ERROR" => Some(Level::ERROR),
        "WARN" | "WARNING" => Some(Level::WARN),
        "INFO" => Some(Level::INFO),
        "DEBUG" => Some(Level::DEBUG),
        "TRACE" => Some(Level::TRACE),
        _ => None,
    }
}

async fn logs(
    State(state): State<Arc<AppState>>,
    Query(q): Query<LogsQuery>,
) -> Json<Vec<LogEntry>> {
    Json(state.logs.entries(
        parse_level(q.level.as_deref()),
        q.limit.unwrap_or(300),
        q.search.as_deref(),
    ))
}

async fn clear_logs(State(state): State<Arc<AppState>>) -> Json<Value> {
    state.logs.clear();
    Json(json!({ "ok": true }))
}

async fn reindex() -> &'static str {
    "Reindex triggered (stub)"
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/mcp-servers", get(mcp_servers::list).post(mcp_servers::create))
        .route("/mcp-servers/export", get(mcp_servers::export))
        .route("/mcp-servers/{id}", get(mcp_servers::get_by_id).put(mcp_servers::update).delete(mcp_servers::delete))
        .route("/mcp-servers/{id}/restart", post(mcp_servers::restart))
        .route("/mcp-servers/{id}/stats", get(mcp_servers::stats))
        .route("/mcp-servers/{id}/reindex", post(mcp_servers::reindex))
        .route("/mcp-servers/reindex/job/{job_id}", get(mcp_servers::reindex_job))
        .route("/skills", get(skills::list).post(skills::create))
        .route("/skills/{id}", get(skills::get_by_id).put(skills::update).delete(skills::delete))
        .route("/skills/import", post(skills::import_skills))
        .route("/skills/upload", post(skills::upload_skills))
        .route("/skills/export", get(skills::export_skills))
        .route("/config-profiles", get(configs::list).post(configs::create))
        .route("/config-profiles/{id}", get(configs::get_by_id).put(configs::update).delete(configs::delete))
        .route("/client-versions", get(client_versions::list).post(client_versions::create))
        .route("/client-versions/{id}", get(client_versions::get_by_id).put(client_versions::update).delete(client_versions::delete))
        .route("/clients", get(clients::list))
        .route("/status", get(status))
        .route("/settings", get(settings::list).put(settings::upsert))
        .route("/logs", get(logs))
        .route("/logs/clear", post(clear_logs))
        .route("/fs/browse", get(fs::browse))
        .route("/auth/rotate", post(crate::auth::rotate_handler))
        .route("/auth/token", get(crate::auth::token_handler))
        .route("/auth/login", post(crate::auth::login_handler))
        .route("/auth/me", get(crate::auth::me_handler))
        .route("/auth/password", post(crate::auth::password_handler))
        .route("/users", get(users::list).post(users::create))
        .route("/users/{id}", put(users::update).delete(users::delete))
        .route("/users/{id}/reset-password", post(users::reset_password))
        .route("/users/{id}/password", post(users::set_password))
        .route("/reindex", post(reindex))
        .route("/bsl-ls", get(bsl_ls::get_state))
        .route("/bsl-ls/config", post(bsl_ls::update_config))
        .route("/bsl-ls/restart", post(bsl_ls::restart))
        .route("/bsl-ls/stop", post(bsl_ls::stop))
        .route("/bsl-ls/install-java", post(bsl_ls::install_java_endpoint))
        .route("/bsl-ls/logs", get(bsl_ls::get_logs))
        .route("/bsl-ls/logs/clear", post(bsl_ls::clear_logs_endpoint))
        .route("/bsl-ls/versions", get(bsl_ls::get_versions))
        .route("/bsl-ls/download/{version}", post(bsl_ls::download_bsl_ls))
        .route("/agent-files", get(agent_files::overview))
        .route("/agent-files/tools", get(agent_files::known_tools))
        .route("/agent-files/agents", post(agent_files::create_agent))
        .route("/agent-files/agents/{name}", put(agent_files::update_agent).delete(agent_files::delete_agent))
        .route("/agent-files/skills", post(agent_files::create_skill))
        .route("/agent-files/skills/{name}", put(agent_files::update_skill).delete(agent_files::delete_skill))
        .route("/agent-files/patterns", post(agent_files::create_pattern))
        .route("/agent-files/patterns/{name}", put(agent_files::update_pattern).delete(agent_files::delete_pattern))
        .route("/agent-backend/status", get(agent_backend::status))
        .route("/agent-backend/up", post(agent_backend::up))
        .route("/agent-backend/stop", post(agent_backend::stop))
        .route("/agent-backend/restart", post(agent_backend::restart))
        .route("/agent-backend/logs", get(agent_backend::logs))
        .route("/agent-backend/env", get(agent_backend::env_list).put(agent_backend::env_put))
        .route("/agent-backend/live/agents", get(agent_backend::live_agents))
        .route("/agent-backend/live/skills", get(agent_backend::live_skills))
        .route("/agent-backend/live/tools", get(agent_backend::live_tools))
}
