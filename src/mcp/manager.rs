use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::config::McpServerConfig;
use super::protocol::{JsonRpcRequest, JsonRpcResponse};
use super::session::McpSession;

pub struct McpManager {
    sessions: RwLock<HashMap<String, McpSession>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub async fn load_from_db(&self, db: &Arc<tokio::sync::Mutex<crate::db::Database>>) {
        let guard = db.lock().await;
        let configs = match McpServerConfig::load_all(&*guard) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Failed to load MCP configs: {}", e);
                return;
            }
        };
        for config in &configs {
            if let Err(e) = self.start_server(config).await {
                tracing::error!("Failed to start MCP server '{}': {}", config.id, e);
            }
        }
    }

    pub async fn start_server(&self, config: &McpServerConfig) -> Result<(), Box<dyn std::error::Error>> {
        if config.transport != "stdio" {
            tracing::warn!("MCP server '{}': transport '{}' not yet supported", config.id, config.transport);
            return Ok(());
        }
        // Hot-reload safe: stop previous session for this id first.
        self.stop_server(&config.id).await;
        let session = McpSession::start(config).await?;
        self.sessions.write().await.insert(config.id.clone(), session);
        tracing::info!("MCP server '{}' started", config.id);
        Ok(())
    }

    pub async fn stop_server(&self, id: &str) {
        let mut sessions = self.sessions.write().await;
        if let Some(mut session) = sessions.remove(id) {
            session.shutdown().await;
            tracing::info!("MCP server '{}' stopped", id);
        }
    }

    pub async fn is_running(&self, id: &str) -> bool {
        self.sessions.read().await.contains_key(id)
    }

    /// Ask a running session for its tool list (used by the aggregated gateway).
    pub async fn list_tools(&self, server_id: &str) -> Result<Vec<serde_json::Value>, McpError> {
        let req = JsonRpcRequest::new("tools/list", serde_json::json!({}));
        let resp = self.call(server_id, req).await?;
        Ok(resp
            .result
            .and_then(|r| r.get("tools").cloned())
            .and_then(|t| t.as_array().cloned())
            .unwrap_or_default())
    }

    /// Call a single tool on a running session, return the raw `result`.
    pub async fn call_tool(
        &self,
        server_id: &str,
        tool: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, McpError> {
        let req = JsonRpcRequest::new(
            "tools/call",
            serde_json::json!({ "name": tool, "arguments": arguments }),
        );
        let resp = self.call(server_id, req).await?;
        if let Some(err) = resp.error {
            return Err(McpError::CallError(err.message));
        }
        Ok(resp.result.unwrap_or(serde_json::Value::Null))
    }

    pub async fn call(&self, server_id: &str, request: JsonRpcRequest) -> Result<JsonRpcResponse, McpError> {
        let client_id = request.id.clone();
        let sessions = self.sessions.read().await;
        let session = sessions.get(server_id).ok_or_else(|| McpError::NotFound(server_id.to_string()))?;
        let mut response = session.call(request).await.map_err(|e| McpError::CallError(e.to_string()))?;
        if let Some(cid) = client_id {
            response.id = cid;
        }
        Ok(response)
    }

    pub async fn shutdown_all(&self) {
        let mut sessions = self.sessions.write().await;
        for (_, mut session) in sessions.drain() {
            session.shutdown().await;
        }
    }
}

#[derive(Debug)]
pub enum McpError {
    NotFound(String),
    CallError(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::NotFound(id) => write!(f, "MCP server '{}' not found", id),
            McpError::CallError(msg) => write!(f, "MCP call failed: {}", msg),
        }
    }
}

impl std::error::Error for McpError {}
