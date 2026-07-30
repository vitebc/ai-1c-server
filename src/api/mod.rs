use std::sync::Arc;
use axum::{Router, routing::{get, post}};
use tokio::sync::Mutex;

use crate::db::Database;
use crate::mcp::{BslLsManager, McpManager};

mod admin;
mod mcp;
mod mcp_skills;

pub struct AppState {
    pub db: Arc<Mutex<Database>>,
    pub mcp: Arc<McpManager>,
    pub bsl_ls: Arc<BslLsManager>,
    pub data_dir: String,
}

async fn health() -> &'static str {
    "OK"
}

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/mcp/{server_id}", post(mcp::call_server))
        .route("/api/mcp-skills/rpc", post(mcp_skills::handle_mcp_skills))
        .nest("/api/admin", admin::routes())
        .with_state(state)
}
