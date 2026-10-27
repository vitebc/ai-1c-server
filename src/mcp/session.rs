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

/// Пинг живости (is_running): короткий, чтобы дашборд не висел на мёртвых
/// сессиях. Мёртвый subprocess держит pipe открытым (write-end у нас),
/// поэтому запись «уходит в никуда» без ошибки — единственная честная
/// проверка: ответили ли вообще.
const PING_TIMEOUT: Duration = Duration::from_secs(3);

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
    /// PID subprocess'а на момент spawn. Зомби с тем же pid — процесс уже
    /// умер (ядро держит запись до reap'а), живой процесс с таким pid —
    /// только если pid перекрутился, что за секунды не происходит.
    child_pid: u32,
    /// Ридер stdout-потока: его выход (EOF/ошибка) = смерть subprocess'а.
    /// `processExited()` не ловит зомби, пока родитель не сделал waitpid() —
    /// на long-running демоне такие записи живут днями и маскируют мёртвый
    /// pipe как живой. Reader-сигнал надёжнее: поток завершился, когда
    /// subprocess умер, независимо от того, reaped он или нет.
    reader_done: Arc<Mutex<Option<oneshot::Receiver<()>>>>,
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

        // Считаем PID: если process_exited() видит зомби/отсутствие записи —
        // subprocess умер (в т.ч. от замены бинарника на месте), и пинг
        // может вестись в никуда по мёртвому pipe.
        let child_pid = child.id().expect("spawned process has an id");

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
        let (reader_done_tx, reader_done) = oneshot::channel::<()>();

        // Фоновый ридер: единственный владелец stdout. Разбирает построчно
        // и раскидывает ответы по id, поэтому вызовы мультиплексируются —
        // несколько агентов ждут от одного subprocess одновременно.
        if let Some(stdout) = child.stdout.take() {
            let pending = pending.clone();
            tokio::spawn(async move {
                let mut reader_done_tx = Some(reader_done_tx);
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
                // Поток закрылся: все ждущие об этом узнают по oneshot,
                // а сессия — по reader_done (смерть subprocess'а).
                if let Some(tx) = reader_done_tx.take() {
                    let _ = tx.send(());
                }
                pending.lock().await.clear();
            });
        }

        let process: Arc<Mutex<Option<tokio::process::Child>>> = Arc::new(Mutex::new(Some(child)));

        // Реапер: tokio не собирает exit-код, пока `Child` лежит в поле —
        // зомби копятся днями, а причина смерти остаётся неизвестной.
        // Раз в 3 c забираем статус: логируем код/сигнал и освобождаем поле.
        {
            let process = process.clone();
            let log_id = config.id.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    let mut guard = process.lock().await;
                    let Some(child) = guard.as_mut() else { break };
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            tracing::warn!(
                                "[mcp:{}] subprocess exited: {} — сессия мертва",
                                log_id,
                                status
                            );
                            *guard = None; // запись забрана, зомби нет
                            break;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            tracing::warn!("[mcp:{}] try_wait failed: {e}", log_id);
                            break;
                        }
                    }
                }
            });
        }

        let session = Self {
            id: config.id.clone(),
            process,
            child_pid,
            reader_done: Arc::new(Mutex::new(Some(reader_done))),
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

    async fn send_notification(
        &self,
        msg: &serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut line = serde_json::to_string(msg)?;
        line.push('\n');
        let mut writer = self.writer.lock().await;
        writer.write_all(line.as_bytes()).await?;
        writer.flush().await?;
        Ok(())
    }

    pub async fn call(
        &self,
        request: JsonRpcRequest,
    ) -> Result<JsonRpcResponse, Box<dyn std::error::Error>> {
        self.call_with_timeout(request, CALL_TIMEOUT).await
    }

    /// Пинг живости: короткий таймаут + честная проверка ответа.
    /// Мёртвый subprocess не отвечает вовсе (pipe записывается в никуда),
    /// поэтому по таймауту — false, а не «запись прошла = жив».
    pub async fn ping(&self) -> bool {
        if self.process_exited() {
            return false;
        }
        let req = JsonRpcRequest::new("ping", serde_json::json!({}));
        match self.call_with_timeout(req, PING_TIMEOUT).await {
            // Ответ с result — жив. Ответ с error (сервер живой, но не знает
            // метода ping) тоже считается живым: процесс отвечает.
            Ok(resp) => resp.result.is_some() || resp.error.is_some(),
            Err(_) => false,
        }
    }

    async fn call_with_timeout(
        &self,
        request: JsonRpcRequest,
        timeout_dur: Duration,
    ) -> Result<JsonRpcResponse, Box<dyn std::error::Error>> {
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

        match timeout(timeout_dur, rx).await {
            Ok(Ok(value)) => Ok(serde_json::from_value(value)?),
            // Фоновой ридер умер вместе с subprocess — отвечаем тем же текстом,
            // что и раньше.
            Ok(Err(_)) => Err("MCP subprocess connection closed".into()),
            Err(_) => {
                self.pending.lock().await.remove(&req_id);
                Err(format!("MCP call timed out after {}s", timeout_dur.as_secs()).into())
            }
        }
    }

    /// Быстрая проверка смерти subprocess без пинга. Два независимых
    /// сигнала: reader-поток завершился (stdout EOF — subprocess умер) или
    /// /proc записи нет вообще. Сигнал «Z в /proc/<pid>/stat» НЕ работает:
    /// tokio не reaps детей, пока `Child` живёт в поле `process`, поэтому
    /// зомби живут до shutdown() и маскируют смерть как живой процесс.
    pub fn process_exited(&self) -> bool {
        // 1) Reader-сигнал: stdout закрылся, поток завершил работу.
        //    try_lock + take: сигнал одноразовый, дальше поле пусто и
        //    проверка всегда «мёртв».
        if let Ok(mut guard) = self.reader_done.try_lock() {
            if let Some(mut rx) = guard.take() {
                if rx.try_recv().is_ok() {
                    return true;
                }
            } else {
                return true; // сигнал уже взят ранее — сессия мёртвая
            }
        }
        // 2) /proc записи нет — процесс точно мёртв (и reaped).
        let stat = match std::fs::read_to_string(format!("/proc/{}/stat", self.child_pid)) {
            Ok(s) => s,
            Err(_) => return true,
        };
        // Формат: pid (comm) state ... — comm может содержать пробелы и
        // скобки, поэтому ищем последнюю закрывающую скобку.
        let Some(open) = stat.rfind(')') else { return true };
        let rest = &stat[open + 1..];
        let state = rest.chars().next();
        // Z — зомби (умер, не reaped), X/x — мёртв. S/R/D/T... — жив.
        matches!(state, Some('Z') | Some('X') | Some('x'))
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
