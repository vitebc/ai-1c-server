use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

use super::config::McpServerConfig;
use super::protocol::{JsonRpcRequest, JsonRpcResponse};

struct Inner {
    stdin: tokio::process::ChildStdin,
    reader: BufReader<tokio::process::ChildStdout>,
    next_id: u64,
}

pub struct McpSession {
    #[allow(dead_code)]
    pub id: String,
    process: Option<tokio::process::Child>,
    inner: Arc<Mutex<Inner>>,
}

impl McpSession {
    pub async fn start(config: &McpServerConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let command = config.command.as_deref().ok_or("mcp.command is required")?;
        let mut cmd = Command::new(command);
        if let Some(args_json) = &config.args {
            let args: Vec<String> = serde_json::from_str(args_json)?;
            cmd.args(&args);
        }
        if let Some(env_json) = &config.env {
            let env: HashMap<String, String> = serde_json::from_str(env_json)?;
            cmd.envs(&env);
        }
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn()?;

        let log_id = config.id.clone();
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    tracing::warn!("[mcp:{}] {}", log_id, line.trim());
                    line.clear();
                }
            });
        }

        let inner = Arc::new(Mutex::new(Inner {
            stdin: child.stdin.take().expect("stdin"),
            reader: BufReader::new(child.stdout.take().expect("stdout")),
            next_id: 1,
        }));

        let session = Self {
            id: config.id.clone(),
            process: Some(child),
            inner: inner.clone(),
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

        let mut inner = self.inner.lock().await;
        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        let mut line = serde_json::to_string(&notif)?;
        line.push('\n');
        inner.stdin.write_all(line.as_bytes()).await?;
        inner.stdin.flush().await?;
        Ok(())
    }

    pub async fn call(&self, request: JsonRpcRequest) -> Result<JsonRpcResponse, Box<dyn std::error::Error>> {
        let mut inner = self.inner.lock().await;
        let req_id = inner.next_id;
        inner.next_id += 1;

        let mut req = request;
        req.id = Some(serde_json::json!(req_id));

        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        inner.stdin.write_all(line.as_bytes()).await?;
        inner.stdin.flush().await?;

        let target = serde_json::json!(req_id);
        loop {
            let mut buf = String::new();
            match timeout(Duration::from_secs(30), inner.reader.read_line(&mut buf)).await {
                Ok(Ok(0)) | Ok(Err(_)) => return Err("MCP subprocess connection closed".into()),
                Err(_) => return Err("MCP call timed out".into()),
                Ok(Ok(_)) => {}
            }
            let value: serde_json::Value = match serde_json::from_str(&buf) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if value.get("id").map_or(false, |id| id == &target) {
                return Ok(serde_json::from_value(value)?);
            }
        }
    }

    pub async fn shutdown(&mut self) {
        if let Some(mut child) = self.process.take() {
            let _ = child.start_kill().ok();
            let _ = child.wait().await;
        }
    }
}

impl Drop for McpSession {
    fn drop(&mut self) {
        if let Some(ref mut child) = self.process {
            let _ = child.start_kill();
        }
    }
}
