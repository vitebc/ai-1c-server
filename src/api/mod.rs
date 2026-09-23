use std::collections::HashMap;
use std::sync::Arc;
use axum::{Router, routing::{get, post}};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::db::Database;
use crate::log_buffer::LogBuffer;
use crate::mcp::{BslLsManager, McpManager};

pub(crate) mod admin;
mod mcp;
mod mcp_http;
mod mcp_skills;

/// Background full-reindex job (progress polled by Admin UI).
#[derive(Debug, Clone, Serialize)]
pub struct ReindexJob {
    pub job_id: String,
    pub server_id: String,
    pub server_name: String,
    /// running | done | error
    pub state: String,
    pub progress: u8,
    pub message: String,
    pub roots: Vec<String>,
    pub neighbors: Vec<String>,
    pub deleted: Vec<String>,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub mcp: Arc<McpManager>,
    pub bsl_ls: Arc<BslLsManager>,
    pub logs: LogBuffer,
    pub data_dir: String,
    pub reindex_jobs: Arc<std::sync::Mutex<HashMap<String, ReindexJob>>>,
    pub login_limits: Arc<std::sync::Mutex<HashMap<String, crate::auth::LoginAttempt>>>,
}

async fn health() -> &'static str {
    "OK"
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/mcp/{server_id}", post(mcp::call_server))
        .route("/api/mcp/{server_id}/mcp", get(mcp_http::server_sse).post(mcp_http::server_rpc))
        .route("/api/mcp-aggregated/mcp", get(mcp_http::aggregated_sse).post(mcp_http::aggregated_rpc))
        .route("/api/mcp-skills/rpc", get(mcp_skills::sse_handler).post(mcp_skills::handle_mcp_skills))
        .nest("/api/admin", admin::routes())
        .with_state(state)
}
