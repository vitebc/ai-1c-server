//! Приложение: публичное API автообновления десктоп-клиента (Tauri updater).
//!
//! Роуты вешаются ТОЛЬКО на шлюз OpenCode (:9020) — клиент AI 1C ходит туда
//! и без авторизации. Основной сервер :9224 эти маршруты не получает.
//!
//! * `GET /api/update/check?version=&platform=&arch=&channel=` — flat-JSON
//!   `{version, notes, pub_date, url, signature}` (200) или 204 No Content.
//! * `GET|HEAD /api/update/download/{file}` — статика из data/releases/.
//! * `POST /api/update/heartbeat` — факт жизни клиента (app_clients).

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::AppState;

// ─── настройки обновления (server_settings) ──────────────────────────

pub const SET_ENABLED: &str = "app_update_enabled";
pub const SET_BASE_URL: &str = "app_update_base_url";
pub const SET_CHANNEL: &str = "app_update_channel";
pub const SET_REQUIRE_SIG: &str = "app_update_require_signature";
pub const SET_PUBKEY: &str = "app_update_pubkey";

/// Каталог с файлами релизов. Дефолт `<data_dir>/releases`; переопределяется
/// env `AI1C_RELEASES_DIR` (абсолютный путь).
pub fn releases_dir(data_dir: &str) -> String {
    if let Some(d) = std::env::var("AI1C_RELEASES_DIR").ok().filter(|v| !v.trim().is_empty()) {
        return d;
    }
    format!("{}/releases", data_dir.trim_end_matches('/'))
}

pub fn get_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM server_settings WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .ok()
}

pub fn falsy(v: &str) -> bool {
    matches!(v.trim().to_lowercase().as_str(), "" | "0" | "false" | "no" | "off")
}

/// Текущие настройки обновления (для админки).
pub fn settings_snapshot(data_dir: &str, conn: &rusqlite::Connection) -> Value {
    let enabled = !falsy(&get_setting(conn, SET_ENABLED).unwrap_or_default());
    let channel = get_setting(conn, SET_CHANNEL).unwrap_or_else(|| "stable".into());
    let require_sig = !falsy(&get_setting(conn, SET_REQUIRE_SIG).unwrap_or_default());
    let pubkey = get_setting(conn, SET_PUBKEY).filter(|s| !s.trim().is_empty());
    let base_url = get_setting(conn, SET_BASE_URL)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| crate::opencode::gateway_url_default());
    json!({
        "enabled": enabled,
        "base_url": base_url,
        "channel": channel,
        "require_signature": require_sig,
        "pubkey": pubkey,
        "releases_dir": releases_dir(data_dir),
    })
}

// ─── release row ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseRow {
    pub id: i64,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub channel: String,
    pub file_name: String,
    pub original_name: String,
    pub signature: String,
    pub sha256: String,
    pub size: i64,
    pub notes: String,
    pub required: bool,
    pub published: bool,
    pub downloads: i64,
    pub created_by: String,
    pub created_at: String,
}

pub fn row_to_release(row: &rusqlite::Row) -> rusqlite::Result<ReleaseRow> {
    Ok(ReleaseRow {
        id: row.get(0)?,
        version: row.get(1)?,
        platform: row.get(2)?,
        arch: row.get(3)?,
        channel: row.get(4)?,
        file_name: row.get(5)?,
        original_name: row.get(6)?,
        signature: row.get(7)?,
        sha256: row.get(8)?,
        size: row.get(9)?,
        notes: row.get(10)?,
        required: row.get::<_, i32>(11)? != 0,
        published: row.get::<_, i32>(12)? != 0,
        downloads: row.get(13)?,
        created_by: row.get(14)?,
        created_at: row.get(15)?,
    })
}

pub const RELEASE_SELECT: &str = "SELECT id, version, platform, arch, channel, file_name, original_name, \
     signature, sha256, size, notes, required, published, downloads, created_by, created_at FROM app_releases";

// ─── check ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CheckQuery {
    pub version: Option<String>,
    /// linux | windows | darwin; без параметра — определяем по User-Agent.
    pub platform: Option<String>,
    /// x86_64 | aarch64; без параметра — x86_64 (или arm из UA).
    pub arch: Option<String>,
    pub channel: Option<String>,
}

fn ua_of(headers: &axum::http::HeaderMap) -> String {
    headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// Определение платформы по User-Agent (Tauri шлёт `Mozilla/5.0 (Windows NT 10.0...)`
/// или своё имя; надёжнее явный параметр, UA — fallback).
pub fn detect_platform_arch(ua: &str) -> (String, String) {
    let ua = ua.to_lowercase();
    let platform = if ua.contains("windows") {
        "windows"
    } else if ua.contains("mac os x") || ua.contains("darwin") || ua.contains("iphone") || ua.contains("ipad") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if ua.contains("arm64") || ua.contains("aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    (platform.to_string(), arch.to_string())
}

fn row_version(r: &ReleaseRow) -> semver::Version {
    semver::Version::parse(&r.version).unwrap_or_else(|_| semver::Version::new(0, 0, 0))
}

/// Лучший кандидат: опубликованный релиз для (platform, arch, channel) с
/// версией > current. При равном semver побеждает больший id (последний).
pub fn best_release(
    conn: &rusqlite::Connection,
    platform: &str,
    arch: &str,
    channel: &str,
    current: Option<&semver::Version>,
) -> Result<Option<ReleaseRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{} WHERE platform = ?1 AND arch = ?2 AND channel = ?3 AND published = 1 ORDER BY id",
            RELEASE_SELECT
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([platform, arch, channel], |row| row_to_release(row))
        .map_err(|e| e.to_string())?;
    let mut best: Option<ReleaseRow> = None;
    for row in rows.flatten() {
        let Some(v) = semver::Version::parse(&row.version).ok() else {
            continue;
        };
        let better = match current {
            Some(cur) => v > *cur,
            None => true,
        };
        if !better {
            continue;
        }
        let take = best.as_ref().map_or(true, |b| {
            let bv = row_version(b);
            v > bv || (v == bv && row.id > b.id)
        });
        if take {
            best = Some(row);
        }
    }
    Ok(best)
}

/// GET /api/update/check — Tauri updater (dynamic server).
/// 200 + flat JSON при наличии обновления; 204 No Content — нет.
pub async fn check(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(q): Query<CheckQuery>,
) -> Response {
    let result = {
        let db = state.db.lock().await;
        let conn = &db.conn;
        if falsy(&get_setting(conn, SET_ENABLED).unwrap_or_default()) {
            return StatusCode::NO_CONTENT.into_response();
        }
        // Платформа/арх: явные параметры, иначе — из User-Agent.
        let (platform, arch) = match (q.platform.clone(), q.arch.clone()) {
            (Some(p), Some(a)) => (p, a),
            _ => detect_platform_arch(&ua_of(&headers)),
        };
        let channel = q.channel.unwrap_or_else(|| {
            get_setting(conn, SET_CHANNEL).unwrap_or_else(|| "stable".into())
        });
        let current = q.version.as_deref().and_then(|v| semver::Version::parse(v).ok());
        match best_release(conn, &platform, &arch, &channel, current.as_ref()) {
            Ok(Some(r)) => {
                let base_url = get_setting(conn, SET_BASE_URL)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| crate::opencode::gateway_url_default());
                Some((r, base_url))
            }
            Ok(None) => None,
            Err(e) => {
                tracing::error!("update check failed: {e}");
                return (StatusCode::INTERNAL_SERVER_ERROR, "update check failed").into_response();
            }
        }
    };

    let Some((row, base_url)) = result else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let url = format!(
        "{}/api/update/download/{}",
        base_url.trim_end_matches('/'),
        row.file_name
    );
    tracing::info!(
        "update check: {} {}/{} {} -> {}",
        row.version,
        row.platform,
        row.arch,
        q.version.as_deref().unwrap_or("?"),
        url
    );
    let _ = {
        let db = state.db.lock().await;
        db.conn.execute(
            "UPDATE app_releases SET downloads = downloads + 1 WHERE id = ?1",
            [row.id],
        )
    };
    Json(json!({
        "version": row.version,
        "notes": row.notes,
        "pub_date": row.created_at,
        "url": url,
        "signature": row.signature,
        "required": row.required,
    }))
    .into_response()
}

// ─── download ────────────────────────────────────────────────────────

/// GET|HEAD /api/update/download/{file} — статика релиза из data/releases/.
#[axum::debug_handler]
pub async fn download(
    State(state): State<Arc<AppState>>,
    Path(file): Path<String>,
    req: axum::extract::Request,
) -> Response {
    let is_head = req.method() == axum::http::Method::HEAD;
    // Только имена файлов (без слешей, без ..).
    if file.contains('/') || file.contains('\\') || file.contains("..") || file.starts_with('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    let dir = releases_dir(&state.data_dir);
    let path = std::path::Path::new(&dir).join(&file);
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    // Счётчик загрузок по file_name (best-effort, вне ответа).
    let fname = file.clone();
    tokio::spawn(async move {
        let db = state.db.lock().await;
        let _ = db.conn.execute(
            "UPDATE app_releases SET downloads = downloads + 1 WHERE file_name = ?1",
            [fname],
        );
    });
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_from_name(&file))
        .header(header::CONTENT_LENGTH, meta.len().to_string())
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", file),
        );
    let body = if is_head {
        // HEAD: только заголовки.
        axum::body::Body::empty()
    } else {
        match tokio::fs::read(&path).await {
            Ok(b) => axum::body::Body::from(b),
            Err(e) => {
                tracing::error!("update download failed: {e}");
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    };
    resp.body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn mime_from_name(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "appimage" => "application/octet-stream",
        "deb" => "application/vnd.debian.binary-package",
        "rpm" => "application/x-rpm",
        "exe" => "application/vnd.microsoft.portable-executable",
        "msi" => "application/x-msi",
        "app" => "application/octet-stream",
        "dmg" => "application/x-apple-diskimage",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

// ─── heartbeat ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct HeartbeatBody {
    pub client_id: String,
    pub version: Option<String>,
    pub platform: Option<String>,
    pub hostname: Option<String>,
    pub user_name: Option<String>,
}

/// POST /api/update/heartbeat — клиент сообщает о себе (id = uuid клиента).
pub async fn heartbeat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<HeartbeatBody>,
) -> Response {
    if body.client_id.trim().is_empty() || body.client_id.len() > 128 {
        return (StatusCode::BAD_REQUEST, "invalid client_id").into_response();
    }
    let db = state.db.lock().await;
    let _ = db.conn.execute(
        "INSERT INTO app_clients (client_id, version, platform, hostname, user_name)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(client_id) DO UPDATE SET
            version = excluded.version,
            platform = excluded.platform,
            hostname = excluded.hostname,
            user_name = excluded.user_name,
            last_seen_at = datetime('now')",
        rusqlite::params![
            body.client_id.trim(),
            body.version.unwrap_or_default(),
            body.platform.unwrap_or_default(),
            body.hostname.unwrap_or_default(),
            body.user_name.unwrap_or_default(),
        ],
    );
    Json(json!({ "ok": true })).into_response()
}

// ─── тесты ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compare_picks_newer() {
        // 1.0.3 > 1.0.2, но 1.0.10 > 1.0.9 (не строковое сравнение).
        let cur = semver::Version::parse("1.0.2").unwrap();
        assert!(semver::Version::parse("1.0.3").unwrap() > cur);
        assert!(semver::Version::parse("1.0.10").unwrap() > semver::Version::parse("1.0.9").unwrap());
    }

    #[test]
    fn platform_detection_from_ua() {
        assert_eq!(detect_platform_arch("Mozilla/5.0 (Windows NT 10.0; Win64; x64)").0, "windows");
        assert_eq!(detect_platform_arch("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)").0, "darwin");
        assert_eq!(detect_platform_arch("AI-1C/1.0 (X11; Linux x86_64)").0, "linux");
        assert_eq!(detect_platform_arch("AI-1C/1.0 (Linux aarch64)").1, "aarch64");
    }

    #[test]
    fn falsy_parsing() {
        assert!(falsy(""));
        assert!(falsy("0"));
        assert!(falsy("false"));
        assert!(!falsy("1"));
        assert!(!falsy("true"));
    }
}
