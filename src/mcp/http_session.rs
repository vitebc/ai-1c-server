//! Streamable HTTP MCP client (remote servers like `rlm-tools-bsl`).
//!
//! Speaks JSON-RPC over `POST {url}` with
//! `Accept: application/json, text/event-stream`:
//! the server answers either with a plain JSON response or with SSE
//! frames (`data: {...}`). Notifications (`notifications/initialized`)
//! are fire-and-forget (HTTP 202 with an empty body is fine).
//! For `http`/`sse` transports the `env` JSON map (`{"Header": "value"}`)
//! is sent as extra HTTP headers.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use super::config::McpServerConfig;
use super::protocol::{JsonRpcRequest, JsonRpcResponse};

pub struct HttpMcpSession {
    pub id: String,
    url: String,
    client: reqwest::Client,
    headers: HashMap<String, String>,
    next_id: Arc<Mutex<u64>>,
}

impl HttpMcpSession {
    pub async fn start(config: &McpServerConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let url = config
            .url
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or("mcp.url is required for http/sse transport")?;
        let mut headers = HashMap::new();
        if let Some(env_json) = config.env.as_deref().filter(|s| !s.trim().is_empty()) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, String>>(env_json) {
                headers = map;
            }
        }
        let session = Self {
            id: config.id.clone(),
            url: url.to_string(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(35))
                .build()?,
            headers,
            next_id: Arc::new(Mutex::new(1)),
        };
        session.initialize().await?;
        Ok(session)
    }

    async fn initialize(&self) -> Result<(), Box<dyn std::error::Error>> {
        let req = JsonRpcRequest::new(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "ai-1c-server", "version": "0.1.0" }
            }),
        );
        self.call(req).await?;
        // Notification: no id, server answers 202/empty — ignore the outcome.
        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        let _ = self.post(&notif).await;
        Ok(())
    }

    pub async fn call(
        &self,
        mut request: JsonRpcRequest,
    ) -> Result<JsonRpcResponse, Box<dyn std::error::Error>> {
        let req_id = {
            let mut n = self.next_id.lock().await;
            let id = *n;
            *n += 1;
            id
        };
        request.id = Some(serde_json::json!(req_id));
        let body = serde_json::to_value(&request)?;
        let target = serde_json::json!(req_id);
        let value = self.post(&body).await?;
        // Plain JSON-RPC response.
        if value.get("id").map_or(false, |id| id == &target) {
            return Ok(serde_json::from_value(value)?);
        }
        Err(format!("MCP HTTP: no response with id {req_id} from {}", self.url).into())
    }

    /// POST one JSON-RPC message, parse JSON or SSE (`data:`) response.
    /// Returns `Null` for empty (202 notification ack).
    async fn post(&self, body: &serde_json::Value) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let mut req = self
            .client
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .json(body);
        for (k, v) in &self.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let resp = req.send().await?;
        if !resp.status().is_success() {
            let code = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let head = text.chars().take(300).collect::<String>();
            return Err(format!("MCP HTTP {} -> {code}: {head}", self.url).into());
        }
        let text = resp.text().await.unwrap_or_default();
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Null);
        }
        // SSE framing: collect `data:` payloads, prefer the one matching our id.
        if text.contains("data:") {
            let want_id = body.get("id").cloned();
            let mut fallback: Option<serde_json::Value> = None;
            for line in text.lines() {
                let payload = line.strip_prefix("data:").map(str::trim).unwrap_or("");
                if payload.is_empty() || payload == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                    if let Some(w) = &want_id {
                        if v.get("id").map_or(false, |id| id == w) {
                            return Ok(v);
                        }
                    }
                    if fallback.is_none() && (v.get("result").is_some() || v.get("error").is_some()) {
                        fallback = Some(v);
                    }
                }
            }
            if let Some(v) = fallback {
                return Ok(v);
            }
            return Err(format!("MCP HTTP: unparseable SSE response from {}", self.url).into());
        }
        Ok(serde_json::from_str(&text)?)
    }
}
