use std::sync::Arc;
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use axum::http::StatusCode;

use crate::mcp::{JsonRpcRequest, JsonRpcResponse, McpError, McpManager};

pub async fn call_server(
    State(manager): State<Arc<McpManager>>,
    Path(server_id): Path<String>,
    Json(request): Json<JsonRpcRequest>,
) -> Result<Json<JsonRpcResponse>, McpError> {
    let response = manager.call(&server_id, request).await?;
    Ok(Json(response))
}

impl IntoResponse for McpError {
    fn into_response(self) -> axum::response::Response {
        let (status, body) = match &self {
            McpError::NotFound(_) => (StatusCode::NOT_FOUND, self.to_string()),
            McpError::CallError(_) => (StatusCode::BAD_GATEWAY, self.to_string()),
        };
        (status, Json(serde_json::json!({
            "jsonrpc": "2.0",
            "id": null,
            "error": { "code": -32000, "message": body }
        }))).into_response()
    }
}
