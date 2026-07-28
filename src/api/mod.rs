use std::sync::Arc;
use axum::{Router, routing::{get, post}};

use crate::mcp::McpManager;

mod admin;
mod mcp;

async fn health() -> &'static str {
    "OK"
}

pub fn routes(manager: Arc<McpManager>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/mcp/{server_id}", post(mcp::call_server))
        .nest("/api/admin", admin::routes())
        .with_state(manager)
}
