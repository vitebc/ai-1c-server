use std::collections::HashMap;
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

    pub async fn load_from_db(&self, db: &crate::db::Database) {
        let configs = match McpServerConfig::load_all(db) {
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
        let session = McpSession::start(config).await?;
        self.sessions.write().await.insert(config.id.clone(), session);
        Ok(())
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
