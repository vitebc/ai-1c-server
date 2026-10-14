use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

use super::config::McpServerConfig;
use super::protocol::{JsonRpcRequest, JsonRpcResponse};

/// Один MCP-вызов: сколько ждём ответа дошпросцесса.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// Пишем в stdin только под этим локом — и только на время одной строки.
/// Ответ читает фоновой task, поэтому долгий вызов не блокирует соседние.
type Writer = Arc<Mutex<tokio::process::ChildStdin>>;

/// Канал «ответ пришёл» на конкретный JSON-RPC id.
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>;

pub struct McpSession {
    #[allow(dead_code)]
    pub id: String,
    /// Внутри `Mutex`, а не просто `Option`: сессия живёт под `Arc`
    /// (см. `McpManager::call`), и остановить её должен любой владелец.
    process: Arc<Mutex<Option<tokio::process::Child>>>,
    writer: Writer,
    next_id: Arc<Mutex<u64>>,
    pending: Pending,
}

impl McpSession {
    pub async fn start(config: &McpServerConfig) -> Result<Self, Box<dyn std::error::Error>> {
        let command = config.command.as_deref().ok_or("mcp.command is required")?;
        let mut cmd = Command::new(command);
        if let Some(args_json) = config.args.as_deref().filter(|s| !s.trim().is_empty()) {
            let args: Vec<String> = serde_json::from_str(args_json)?;
            cmd.args(&args);
        }
        if let Some(env_json) = config.env.as_deref().filter(|s| !s.trim().is_empty()) {
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

        let writer: Writer = Arc::new(Mutex::new(child.stdin.take().expect("stdin")));
        let next_id = Arc::new(Mutex::new(1u64));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));

        // Фоновый ридер: единственный владелец stdout. Разбирает построчно
        // и раскидывает ответы по id, поэтому вызовы мультиплексируются —
        // несколько агентов ждут от одного subprocess одновременно.
        if let Some(stdout) = child.stdout.take() {
            let pending = pending.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) | Err(_) => break, // EOF или битый поток
                        Ok(_) => {}
                    }
                    let value: serde_json::Value = match serde_json::from_str(line.trim_end()) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    // Ответ на наш запрос: id — число. Всё остальное
                    // (нотификации сервера) — просто логируем.
                    let id = match value.get("id").and_then(|v| v.as_u64()) {
                        Some(i) => i,
                        None => {
                            tracing::debug!("[mcp] unsolicited: {}", line.trim());
                            continue;
                        }
                    };
                    let tx = pending.lock().await.remove(&id);
                    match tx {
                        Some(tx) => {
                            let _ = tx.send(value);
                        }
                        // Ответ на уже отменённый по таймауту вызов.
                        None => tracing::debug!("[mcp] late response for id {id}, dropped"),
                    }
                }
                // Поток закрылся: все ждущие об этом узнают по oneshot.
                pending.lock().await.clear();
            });
        }

        let session = Self {
            id: config.id.clone(),
            process: Arc::new(Mutex::new(Some(child))),
            writer,
            next_id,
            pending,
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

        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        self.send_notification(&notif).await?;
        Ok(())
    }

    async fn send_notification(&self, msg: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
        let mut line = serde_json::to_string(msg)?;
        line.push('\n');
        let mut writer = self.writer.lock().await;
        writer.write_all(line.as_bytes()).await?;
        writer.flush().await?;
        Ok(())
    }

    pub async fn call(&self, request: JsonRpcRequest) -> Result<JsonRpcResponse, Box<dyn std::error::Error>> {
        let req_id = {
            let mut n = self.next_id.lock().await;
            let id = *n;
            *n += 1;
            id
        };

        let mut req = request;
        req.id = Some(serde_json::json!(req_id));

        // Регистрируем канал ДО записи: иначе быстрый ответ придёт
        // раньше, чем мы его подписываем, и потеряется.
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(req_id, tx);

        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        {
            let mut writer = self.writer.lock().await;
            if let Err(e) = writer.write_all(line.as_bytes()).await {
                self.pending.lock().await.remove(&req_id);
                return Err(e.into());
            }
            if let Err(e) = writer.flush().await {
                self.pending.lock().await.remove(&req_id);
                return Err(e.into());
            }
        }

        match timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(value)) => Ok(serde_json::from_value(value)?),
            // Фоновой ридер умер вместе с subprocess — отвечаем тем же текстом,
            // что и раньше.
            Ok(Err(_)) => Err("MCP subprocess connection closed".into()),
            Err(_) => {
                self.pending.lock().await.remove(&req_id);
                Err(format!("MCP call timed out after {}s", CALL_TIMEOUT.as_secs()).into())
            }
        }
    }

    pub async fn shutdown(&self) {
        let child = self.process.lock().await.take();
        if let Some(mut child) = child {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
}

impl Drop for McpSession {
    fn drop(&mut self) {
        // Синхронно, без await: если сессию отбросили без shutdown(),
        // всё равно убиваем subprocess.
        if let Ok(mut guard) = self.process.try_lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.start_kill();
            }
        }
    }
}