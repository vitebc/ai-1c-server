use std::sync::Arc;
use axum::Router;

use crate::mcp::McpManager;

pub fn routes() -> Router<Arc<McpManager>> {
    Router::new()
}
