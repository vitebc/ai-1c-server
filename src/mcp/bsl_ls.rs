use std::path::Path;
use serde::Serialize;
use tokio::sync::Mutex;
use tokio::process::{Command, Child};

#[derive(Debug, Clone)]
pub struct BslLsConfig {
    pub java_path: String,
    pub jar_path: String,
    pub port: u16,
    pub enabled: bool,
    pub data_dir: String,
}

impl BslLsConfig {
    pub fn new(data_dir: &str) -> Self {
        Self {
            java_path: "java".into(),
            jar_path: format!("{}/bsl-language-server.jar", data_dir),
            port: 8025,
            enabled: false,
            data_dir: data_dir.into(),
        }
    }
}

impl BslLsConfig {
    pub fn load(db: &crate::db::Database, default_data_dir: &str) -> Self {
        fn get_val(conn: &rusqlite::Connection, key: &str) -> Option<String> {
            conn.query_row(
                "SELECT value FROM server_settings WHERE key = ?1",
                [key],
                |row| row.get::<_, String>(0),
            ).ok()
        }
        let conn = &db.conn;
        let data_dir = get_val(conn, "bsl_ls_data_dir").unwrap_or_else(|| default_data_dir.into());
        Self {
            java_path: get_val(conn, "bsl_ls_java_path").unwrap_or_else(|| "java".into()),
            jar_path: get_val(conn, "bsl_ls_jar_path").unwrap_or_else(|| format!("{}/bsl-language-server.jar", data_dir)),
            port: get_val(conn, "bsl_ls_port").and_then(|v| v.parse().ok()).unwrap_or(8025),
            enabled: get_val(conn, "bsl_ls_enabled").map(|v| v == "true").unwrap_or(false),
            data_dir,
        }
    }

    pub fn save(&self, db: &crate::db::Database) -> Result<(), Box<dyn std::error::Error>> {
        let conn = &db.conn;
        let enabled_str = if self.enabled { "true".to_string() } else { "false".to_string() };
        let pairs: [(&str, &String); 5] = [
            ("bsl_ls_java_path", &self.java_path),
            ("bsl_ls_jar_path", &self.jar_path),
            ("bsl_ls_port", &self.port.to_string()),
            ("bsl_ls_enabled", &enabled_str),
            ("bsl_ls_data_dir", &self.data_dir),
        ];
        for (key, value) in &pairs {
            conn.execute(
                "INSERT INTO server_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = ?2",
                rusqlite::params![key, value],
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BslLsStatus {
    Stopped,
    Running { pid: u32 },
    Error(String),
}

pub struct BslLsManager {
    config: Mutex<BslLsConfig>,
    process: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
}

impl BslLsManager {
    pub fn new(data_dir: &str) -> Self {
        Self {
            config: Mutex::new(BslLsConfig::new(data_dir)),
            process: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }

    pub async fn load_config(&self, db: &crate::db::Database, data_dir: &str) {
        let config = BslLsConfig::load(db, data_dir);
        let start_it = config.enabled;
        *self.config.lock().await = config;
        if start_it {
            self.start().await;
        }
    }

    pub async fn get_config(&self) -> BslLsConfig {
        self.config.lock().await.clone()
    }

    pub async fn update_config(&self, config: BslLsConfig) {
        *self.config.lock().await = config;
    }

    pub async fn start(&self) {
        let mut proc = self.process.lock().await;
        if proc.is_some() {
            return;
        }
        let cfg = self.config.lock().await.clone();

        let java_path = cfg.java_path.trim();
        let jar_path = cfg.jar_path.trim();

        if java_path.contains('/') || java_path.contains('\\') {
            if !Path::new(java_path).exists() {
                let msg = format!("Java not found: {}", java_path);
                tracing::error!("{}", msg);
                *self.last_error.lock().await = Some(msg);
                return;
            }
        }
        if jar_path.contains('/') || jar_path.contains('\\') {
            if !Path::new(jar_path).exists() {
                let msg = format!("BSL LS JAR not found: {}", jar_path);
                tracing::error!("{}", msg);
                *self.last_error.lock().await = Some(msg);
                return;
            }
        }

        let mut cmd = Command::new(java_path);
        cmd.args(["-jar", jar_path, "--tcp", &cfg.port.to_string()]);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("Failed to spawn BSL LS: {}", e);
                tracing::error!("{}", msg);
                *self.last_error.lock().await = Some(msg);
                return;
            }
            };

        let pid = child.id().unwrap_or(0);
        *self.last_error.lock().await = None;

        let log_id = pid;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut reader = tokio::io::BufReader::new(stderr);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    tracing::info!("[bsl-ls:{}] {}", log_id, line.trim());
                    line.clear();
                }
            });
        }

        tracing::info!("BSL LS started (PID: {}, port: {})", pid, cfg.port);
        *proc = Some(child);
    }

    pub async fn stop(&self) {
        let mut proc = self.process.lock().await;
        if let Some(mut child) = proc.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
            *self.last_error.lock().await = None;
            tracing::info!("BSL LS stopped");
        }
    }

    pub async fn restart(&self) {
        self.stop().await;
        self.start().await;
    }

    pub async fn status(&self) -> BslLsStatus {
        let mut proc = self.process.lock().await;
        if let Some(child) = proc.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let msg = format!("BSL LS exited with code {}", status);
                    tracing::warn!("{}", msg);
                    *proc = None;
                    *self.last_error.lock().await = Some(msg.clone());
                    BslLsStatus::Error(msg)
                }
                Ok(None) => BslLsStatus::Running { pid: child.id().unwrap_or(0) },
                Err(e) => {
                    let msg = format!("BSL LS process error: {}", e);
                    *self.last_error.lock().await = Some(msg.clone());
                    BslLsStatus::Error(msg)
                }
            }
        } else {
            let err = self.last_error.lock().await.clone();
            match err {
                Some(e) => BslLsStatus::Error(e),
                None => BslLsStatus::Stopped,
            }
        }
    }

    pub async fn last_error(&self) -> Option<String> {
        self.last_error.lock().await.clone()
    }
}

pub async fn check_java_at_path(java_path: &str) -> Result<String, String> {
    let path = java_path.to_string();
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new(&path)
            .arg("-version")
            .output()
            .map_err(|e| format!("Java not found at '{}': {}", path, e))?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first = stderr.lines().next().unwrap_or("").to_string();
        if first.is_empty() { Err("No output".into()) } else { Ok(first) }
    }).await.map_err(|e| format!("Task failed: {}", e))?
}

pub async fn check_java_version() -> Result<String, String> {
    let output = tokio::task::spawn_blocking(|| {
        std::process::Command::new("java")
            .arg("-version")
            .output()
    }).await.map_err(|e| format!("Task failed: {}", e))?
    .map_err(|e| format!("Java not found: {}", e))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let first_line = stderr.lines().next().unwrap_or("").to_string();
    if first_line.is_empty() {
        return Err("No output from java -version".into());
    }
    Ok(first_line)
}

#[derive(Debug, Clone, Serialize)]
pub struct BslLsRelease {
    pub version: String,
    pub jar_url: Option<String>,
    pub published_at: String,
}

pub async fn check_bsl_ls_release() -> Result<BslLsRelease, Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .user_agent("ai-1c-server/0.1.0")
        .build()?;
    let resp = client
        .get("https://api.github.com/repos/1c-syntax/bsl-language-server/releases/latest")
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await?;
    let release: serde_json::Value = resp.json().await?;
    let version = release["tag_name"].as_str().unwrap_or("unknown").trim_start_matches('v').to_string();
    let published_at = release["published_at"].as_str().unwrap_or("").to_string();
    let jar_url = release["assets"].as_array().and_then(|assets| {
        assets.iter().find(|a| {
            a["name"].as_str().map(|n| n.ends_with(".jar")).unwrap_or(false)
        }).and_then(|a| a["browser_download_url"].as_str().map(String::from))
    });
    Ok(BslLsRelease { version, jar_url, published_at })
}

pub async fn download_bsl_ls_jar(url: &str, dest: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .user_agent("ai-1c-server/0.1.0")
        .build()?;
    let response = client.get(url).send().await?;
    let bytes = response.bytes().await?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(dest, bytes).await?;
    tracing::info!("BSL LS JAR downloaded to: {}", dest.display());
    Ok(())
}

impl Drop for BslLsManager {
    fn drop(&mut self) {
        if let Some(mut child) = self.process.get_mut().take() {
            let _ = child.start_kill();
        }
    }
}
