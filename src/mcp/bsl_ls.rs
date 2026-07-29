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

        let (java_path, jar_path) = {
            let jp = cfg.java_path.trim().to_string();
            let jarp = cfg.jar_path.trim().to_string();

            // If java_path is just a name (no path separators), check PATH
            // If that fails, try data/java/ as fallback
            let resolved_java = if !jp.contains('/') && !jp.contains('\\') {
                let jp_clone = jp.clone();
                // Check if java is available via PATH
                match tokio::task::spawn_blocking(move || {
                    std::process::Command::new(&jp_clone).arg("-version").output()
                }).await {
                    Ok(Ok(out)) if out.status.success() => jp,
                    _ => {
                        // Fallback: scan data/java/ for java binary
                        let java_dir = Path::new(&cfg.data_dir).join("java");
                        match find_java_in_dir(&java_dir) {
                            Some(found) => {
                                tracing::info!("Found java in data/java: {}", found);
                                found
                            }
                            None => {
                                tracing::warn!("Java not in PATH and not found in {}", java_dir.display());
                                jp
                            }
                        }
                    }
                }
            } else {
                if !Path::new(&jp).exists() {
                    let msg = format!("Java not found: {}", jp);
                    tracing::error!("{}", msg);
                    *self.last_error.lock().await = Some(msg);
                    return;
                }
                jp
            };

            // Resolve jar path
            let resolved_jar = if jarp.contains('/') || jarp.contains('\\') {
                if !Path::new(&jarp).exists() {
                    let msg = format!("BSL LS JAR not found: {}", jarp);
                    tracing::error!("{}", msg);
                    *self.last_error.lock().await = Some(msg);
                    return;
                }
                jarp
            } else {
                jarp
            };

            (resolved_java, resolved_jar)
        };

        let mut cmd = Command::new(&java_path);
        cmd.args(["-jar", &jar_path, "--tcp", &cfg.port.to_string()]);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let hint = match e.raw_os_error() {
                    Some(2) => format!(". Java not found at '{}' — use Install Java button", java_path),
                    Some(13) => format!(". Permission denied for '{}' — check java executable permissions", java_path),
                    _ => "".into(),
                };
                let msg = format!("Failed to spawn BSL LS: {}{}", e, hint);
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

pub async fn download_bsl_ls_jar(url: &str, version: &str, data_dir: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let jar_dir = data_dir.join("bsl-ls");
    tokio::fs::create_dir_all(&jar_dir).await?;

    // Clean old versioned jars
    let mut old_jars = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&jar_dir).await {
        while let Ok(Some(e)) = entries.next_entry().await {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("bsl-language-server-") && name.ends_with(".jar") {
                old_jars.push(e.path());
            }
        }
    }
    for old in &old_jars {
        let _ = tokio::fs::remove_file(old).await;
    }

    let jar_name = format!("bsl-language-server-{}.jar", version);
    let dest = jar_dir.join(&jar_name);

    let client = reqwest::Client::builder()
        .user_agent("ai-1c-server/0.1.0")
        .build()?;
    let response = client.get(url).send().await?;
    let bytes = response.bytes().await?;
    tokio::fs::write(&dest, bytes).await?;
    tracing::info!("BSL LS JAR downloaded: {}", dest.display());
    Ok(dest.to_string_lossy().to_string())
}

pub fn detect_installed_bsl_ls(data_dir: &Path) -> Option<(String, String)> {
    let jar_dir = data_dir.join("bsl-ls");
    let mut best: Option<(String, String)> = None;
    if let Ok(entries) = std::fs::read_dir(&jar_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("bsl-language-server-") || !name.ends_with(".jar") {
                continue;
            }
            let ver = name.trim_start_matches("bsl-language-server-").trim_end_matches(".jar").to_string();
            let replace = best.as_ref().map_or(true, |(b, _)| ver > *b);
            if replace {
                best = Some((ver, entry.path().to_string_lossy().to_string()));
            }
        }
    }
    best
}

/// Synchronous URL fetch via system command (curl on Linux, PowerShell on Windows)
fn fetch_url_sync(url: &str) -> Result<String, String> {
    use std::process::Command;
    if cfg!(windows) {
        let out = Command::new("powershell")
            .args(["-Command", &format!("(Invoke-WebRequest -Uri '{}' -UseBasicParsing).Content", url)])
            .output().map_err(|e| format!("PowerShell failed: {}", e))?;
        if !out.status.success() {
            return Err(format!("PowerShell HTTP error: {}", String::from_utf8_lossy(&out.stderr)));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let out = try_cmd(&[&["curl", "-sL", url], &["wget", "-qO-", url]], None)?;
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }
}

/// Try a series of commands, return first successful output
fn try_cmd(cmds: &[&[&str]], dest: Option<&Path>) -> Result<std::process::Output, String> {
    use std::process::Command;
    let mut last_err = String::new();
    for cmd in cmds {
        let mut child = Command::new(cmd[0]);
        if let Some(d) = dest {
            let d_str = d.to_string_lossy().to_string();
            if cmd[0] == "curl" {
                child.args(&cmd[1..]).arg("-o").arg(&d_str);
            } else {
                child.args(&cmd[1..]).arg("-O").arg(&d_str);
            }
        } else {
            child.args(&cmd[1..]);
        }
        match child.output() {
            Ok(out) if out.status.success() => return Ok(out),
            Ok(out) => last_err = String::from_utf8_lossy(&out.stderr).to_string(),
            Err(e) => last_err = format!("{}: {}", cmd[0], e),
        }
    }
    Err(format!("All download methods failed. Last: {}", last_err))
}

/// Synchronous file download via system command
fn fetch_to_file_sync(url: &str, dest: &Path) -> Result<(), String> {
    if cfg!(windows) {
        use std::process::Command;
        let out = Command::new("powershell")
            .args(["-Command", &format!("Invoke-WebRequest -Uri '{}' -OutFile '{}' -UseBasicParsing", url, dest.display())])
            .output().map_err(|e| format!("PowerShell failed: {}", e))?;
        if !out.status.success() {
            return Err(format!("Download error: {}", String::from_utf8_lossy(&out.stderr)));
        }
        Ok(())
    } else {
        try_cmd(&[&["curl", "-sL", url]], Some(dest)).map(|_| ()).or_else(|_| {
            try_cmd(&[&["wget", "-q", url]], Some(dest)).map(|_| ())
        })
    }
}

/// Find `java` binary inside an extracted JDK directory
fn find_java_in_dir(dir: &Path) -> Option<String> {
    let bin_name = if cfg!(windows) { "java.exe" } else { "java" };
    if !dir.exists() {
        tracing::debug!("find_java_in_dir: {} does not exist", dir.display());
        return None;
    }
    for entry in walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_name() == bin_name {
            #[cfg(unix)]
            if !is_executable(&entry.path()) {
                tracing::debug!("Found java at {} but not executable", entry.path().display());
                continue;
            }
            return Some(entry.path().to_string_lossy().to_string());
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
pub struct JavaInstallInfo {
    pub version: String,
    pub java_path: String,
    pub archive_name: String,
}

pub async fn install_java(data_dir: &Path) -> Result<JavaInstallInfo, Box<dyn std::error::Error>> {
    let data_dir_owned = data_dir.to_path_buf();
    let os = if cfg!(windows) { "windows" } else { "linux" };

    let result: JavaInstallInfo = tokio::task::spawn_blocking(move || {
        use std::process::Command as SyncCommand;

        let api_url = format!(
            "https://api.adoptium.net/v3/assets/latest/17/hotspot?os={}&arch=x64&image_type=jdk", os
        );

        let meta_json = fetch_url_sync(&api_url)?;
        let assets: serde_json::Value = serde_json::from_str(&meta_json).map_err(|e| format!("JSON parse: {}", e))?;
        let asset = assets.as_array().and_then(|a| a.first()).ok_or("No JDK assets")?;
        let version = asset["version"]["semver"].as_str().unwrap_or("unknown").to_string();
        let pkg = &asset["binary"]["package"];
        let archive_url = pkg["link"].as_str().ok_or("No package link")?.to_string();
        let archive_name = pkg["name"].as_str().unwrap_or("jdk.tar.gz");

        let java_dir = data_dir_owned.join("java");
        std::fs::create_dir_all(&java_dir).map_err(|e| format!("mkdir: {}", e))?;
        let archive_path = java_dir.join(&archive_name);

        let _ = std::fs::remove_file(&archive_path);
        fetch_to_file_sync(&archive_url, &archive_path)?;

        let r = if cfg!(windows) {
            SyncCommand::new("powershell")
                .args(["-Command", &format!("Expand-Archive -Path '{}' -DestinationPath '{}' -Force", archive_path.display(), java_dir.display())])
                .output()
        } else {
            SyncCommand::new("tar")
                .args(["-xzf", &archive_path.to_string_lossy(), "-C", &java_dir.to_string_lossy()])
                .output()
        };
        match r {
            Ok(out) if out.status.success() => {}
            Ok(out) => return Err(format!("Extraction failed: {}", String::from_utf8_lossy(&out.stderr))),
            Err(e) => return Err(format!("Extraction error: {}", e)),
        }
        let _ = std::fs::remove_file(&archive_path);
        let java_bin = find_java_in_dir(&java_dir)
            .ok_or_else(|| format!("java binary not found in {}", java_dir.display()))?;

        Ok(JavaInstallInfo { version, java_path: java_bin, archive_name: archive_name.to_string() })
    }).await.map_err(|e| format!("Task panicked: {}", e))?
      .map_err(|e: String| -> Box<dyn std::error::Error> { e.into() })?;

    tracing::info!("Java installed at: {}", result.java_path);
    Ok(result)
}

impl Drop for BslLsManager {
    fn drop(&mut self) {
        if let Some(mut child) = self.process.get_mut().take() {
            let _ = child.start_kill();
        }
    }
}
