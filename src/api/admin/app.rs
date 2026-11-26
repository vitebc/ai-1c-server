//! Приложение: админское API управления релизами десктоп-клиента.
//!
//! * `GET  /api/admin/app/overview` — сводка (релизы, клиенты, настройки).
//! * `POST /api/admin/app/releases` — multipart-загрузка файла + .sig.
//! * `GET/PUT/DELETE /api/admin/app/releases/{id}` — CRUD релизов.
//! * `POST /api/admin/app/releases/{id}/publish` — publish/unpublish.
//! * `GET  /api/admin/app/clients` — клиенты (heartbeat).
//! * `GET/PUT /api/admin/app/settings` — настройки обновления.
//! * `GET  /api/admin/app/update-preview` — предпросмотр ответа клиента.

use std::sync::Arc;

use axum::{
    extract::{Extension, multipart::Multipart, Path, Query, State},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::super::AppState;
use crate::auth::AuthIdentity;
use crate::updater;

// ─── overview ────────────────────────────────────────────────────────

/// GET /api/admin/app/overview — сводка для вкладки «Приложение».
pub async fn overview(State(state): State<Arc<AppState>>) -> Json<Value> {
    let db = state.db.lock().await;
    let conn = &db.conn;
    let releases: Vec<updater::ReleaseRow> = conn
        .prepare(&format!("{} ORDER BY id DESC", updater::RELEASE_SELECT))
        .ok()
        .and_then(|mut s| {
            s.query_map([], |row| updater::row_to_release(row))
                .ok()
                .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    let clients: Vec<Value> = conn
        .prepare(
            "SELECT client_id, version, platform, hostname, user_name, first_seen_at, last_seen_at
             FROM app_clients ORDER BY last_seen_at DESC LIMIT 500",
        )
        .ok()
        .and_then(|mut s| {
            s.query_map([], |row| {
                Ok(json!({
                    "client_id": row.get::<_, String>(0)?,
                    "version": row.get::<_, String>(1)?,
                    "platform": row.get::<_, String>(2)?,
                    "hostname": row.get::<_, String>(3)?,
                    "user_name": row.get::<_, String>(4)?,
                    "first_seen_at": row.get::<_, String>(5)?,
                    "last_seen_at": row.get::<_, String>(6)?,
                }))
            })
            .ok()
            .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    Json(json!({
        "releases": releases,
        "clients": clients,
        "settings": updater::settings_snapshot(&state.data_dir, conn),
    }))
}

// ─── releases list/get ───────────────────────────────────────────────

pub async fn list_releases(State(state): State<Arc<AppState>>) -> Json<Vec<updater::ReleaseRow>> {
    let db = state.db.lock().await;
    let rows: Vec<updater::ReleaseRow> = db
        .conn
        .prepare(&format!("{} ORDER BY id DESC", updater::RELEASE_SELECT))
        .ok()
        .and_then(|mut s| {
            s.query_map([], |row| updater::row_to_release(row))
                .ok()
                .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    Json(rows)
}

pub async fn get_release(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<updater::ReleaseRow>, super::AppError> {
    let db = state.db.lock().await;
    let row = db
        .conn
        .query_row(
            &format!("{} WHERE id = ?1", updater::RELEASE_SELECT),
            [id],
            |row| updater::row_to_release(row),
        )
        .map_err(|_| super::AppBadRequest::msg("release not found"))?;
    Ok(Json(row))
}

// ─── upload (multipart) ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UploadMeta {
    pub version: String,
    #[serde(default = "default_platform")]
    pub platform: String,
    #[serde(default = "default_arch")]
    pub arch: String,
    #[serde(default = "default_channel")]
    pub channel: String,
    /// Подпись можно передать и в meta (вместо отдельного поля sig).
    #[serde(default)]
    pub signature: Option<String>,
    pub notes: Option<String>,
    pub required: Option<bool>,
    pub published: Option<bool>,
}

fn default_platform() -> String {
    "linux".into()
}
fn default_arch() -> String {
    "x86_64".into()
}
fn default_channel() -> String {
    "stable".into()
}

/// POST /api/admin/app/releases — multipart: file (обязательно), sig, meta.
pub async fn upload_release(
    State(state): State<Arc<AppState>>,
    Extension(ident): Extension<AuthIdentity>,
    mut multipart: Multipart,
) -> Result<Json<updater::ReleaseRow>, super::AppError> {
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut sig: Option<String> = None;
    let mut meta_raw: Option<String> = None;

    while let Some(mut field) = multipart.next_field().await? {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => file_bytes = Some(field.bytes().await?.to_vec()),
            _ => {
                // sig/meta — текстовые поля; читаем как bytes и декодируем.
                let b = field.bytes().await?;
                let s = String::from_utf8_lossy(&b).to_string();
                match name.as_str() {
                    "sig" => sig = Some(s),
                    "meta" => meta_raw = Some(s),
                    _ => {}
                }
            }
        }
    }

    let bytes = file_bytes.ok_or_else(|| super::AppBadRequest::msg("file required"))?;
    let sig_field = sig.filter(|s| !s.trim().is_empty());
    let meta: UploadMeta = match meta_raw {
        Some(m) if !m.trim().is_empty() => serde_json::from_str(&m)
            .map_err(|e| super::AppBadRequest::msg(format!("meta: invalid JSON: {e}")))?,
        _ => return Err(super::AppBadRequest::msg("meta required (JSON)").into()),
    };

    // Валидация.
    let version = semver::Version::parse(meta.version.trim())
        .map(|v| v.to_string())
        .map_err(|e| super::AppBadRequest::msg(format!("invalid semver: {e}")))?;
    if !["linux", "windows", "darwin"].contains(&meta.platform.as_str()) {
        return Err(super::AppBadRequest::msg("platform must be linux|windows|darwin").into());
    }
    if !["x86_64", "aarch64"].contains(&meta.arch.as_str()) {
        return Err(super::AppBadRequest::msg("arch must be x86_64|aarch64").into());
    }
    if meta.channel.trim().is_empty() {
        return Err(super::AppBadRequest::msg("channel required").into());
    }
    // Подпись: отдельное поле sig либо meta.signature.
    let sig = match (sig_field, meta.signature.clone()) {
        (Some(s), _) => Some(s),
        (None, s) => s,
        _ => None,
    }
    .filter(|s| !s.trim().is_empty());
    // Подпись опциональна: без неё Tauri updater отклонит обновление на клиенте,
    // но загрузить и проверить пайплайн можно (например, до генерации ключа).

    let sha = format!("{:x}", Sha256::digest(&bytes));
    let size = bytes.len() as i64;
    let notes = meta.notes.clone().unwrap_or_default();

    // Имя файла: AI-1C_<ver>_<platform>_<arch>.<ext из исходного имени>.
    let original = field_file_name(&meta, &bytes);
    let ext = original
        .rsplit_once('.')
        .map(|(_, e)| e.to_string())
        .filter(|e| !e.is_empty() && e.len() <= 8)
        .unwrap_or_else(|| "bin".into());
    let file_name = format!("AI-1C_{}_{}_{}.{}", version, meta.platform, meta.arch, ext);

    // Каталог и запись файла.
    let dir = updater::releases_dir(&state.data_dir);
    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::write(format!("{dir}/{file_name}"), &bytes).await?;

    let username = ident.username.clone();
    let db = state.db.lock().await;
    let res = db.conn.execute(
        "INSERT INTO app_releases (version, platform, arch, channel, file_name, original_name, \
         signature, sha256, size, notes, required, published, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            version,
            meta.platform,
            meta.arch,
            meta.channel.trim(),
            file_name,
            original,
            sig.clone().unwrap_or_default(),
            sha,
            size,
            notes.clone(),
            meta.required.unwrap_or(false) as i32,
            meta.published.unwrap_or(true) as i32,
            username,
        ],
    );
    match res {
        Ok(_) => {}
        Err(e) if e.to_string().contains("UNIQUE") => {
            // Файл уже существует — заменяем содержимое и метаданные.
            db.conn.execute(
                "UPDATE app_releases SET version=?1, platform=?2, arch=?3, channel=?4, \
                 original_name=?5, signature=?6, sha256=?7, size=?8, notes=?9, required=?10, published=?11 \
                 WHERE file_name=?12",
                rusqlite::params![
                    version, meta.platform, meta.arch, meta.channel.trim(), original,
                    sig.clone().unwrap_or_default(), sha, size, notes,
                    meta.required.unwrap_or(false) as i32, meta.published.unwrap_or(true) as i32,
                    file_name,
                ],
            )?;
        }
        Err(e) => return Err(super::AppBadRequest::msg(e.to_string()).into()),
    }
    let row = db
        .conn
        .query_row(
            &format!("{} WHERE file_name = ?1", updater::RELEASE_SELECT),
            [&file_name],
            |row| updater::row_to_release(row),
        )
        .map_err(|e| super::AppBadRequest::msg(e.to_string()))?;
    Ok(Json(row))
}

/// Исходное имя файла (best-effort: версия+платформа+арх).
fn field_file_name(meta: &UploadMeta, _bytes: &[u8]) -> String {
    format!(
        "AI-1C_{}_{}_{}.{}",
        meta.version.trim(),
        meta.platform,
        meta.arch,
        match meta.platform.as_str() {
            "linux" => "AppImage",
            "windows" => "msi",
            "darwin" => "app.tar.gz",
            _ => "bin",
        }
    )
}

// ─── update / delete / publish ───────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UpdateRelease {
    pub notes: Option<String>,
    pub required: Option<bool>,
    pub published: Option<bool>,
    pub signature: Option<String>,
}

pub async fn update_release(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateRelease>,
) -> Result<Json<updater::ReleaseRow>, super::AppError> {
    let db = state.db.lock().await;
    let existing = db
        .conn
        .query_row(
            &format!("{} WHERE id = ?1", updater::RELEASE_SELECT),
            [id],
            |row| updater::row_to_release(row),
        )
        .map_err(|_| super::AppBadRequest::msg("release not found"))?;
    db.conn.execute(
        "UPDATE app_releases SET notes=?1, required=?2, published=?3, signature=?4 WHERE id=?5",
        rusqlite::params![
            body.notes.unwrap_or(existing.notes),
            body.required.unwrap_or(existing.required) as i32,
            body.published.unwrap_or(existing.published) as i32,
            body.signature.unwrap_or(existing.signature),
            id,
        ],
    )?;
    drop(db);
    get_release(State(state), Path(id)).await
}

pub async fn delete_release(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<Value>, super::AppError> {
    let db = state.db.lock().await;
    let file_name: String = match db
        .conn
        .query_row(
            "SELECT file_name FROM app_releases WHERE id = ?1",
            [id],
            |row| row.get(0),
        ) {
        Ok(f) => f,
        Err(_) => return Err(super::AppBadRequest::msg("release not found").into()),
    };
    db.conn.execute("DELETE FROM app_releases WHERE id = ?1", [id])?;
    drop(db);
    // Файл удаляем best-effort (не блокируем удаление записи).
    let dir = updater::releases_dir(&state.data_dir);
    if let Err(e) = tokio::fs::remove_file(format!("{dir}/{file_name}")).await {
        tracing::warn!("app release: file remove failed: {e}");
    }
    Ok(Json(json!({ "ok": true, "file_name": file_name })))
}

#[derive(Debug, Deserialize)]
pub struct PublishBody {
    pub published: bool,
}

pub async fn set_publish(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<PublishBody>,
) -> Result<Json<updater::ReleaseRow>, super::AppError> {
    let db = state.db.lock().await;
    let changes = db.conn.execute(
        "UPDATE app_releases SET published = ?1 WHERE id = ?2",
        rusqlite::params![body.published as i32, id],
    )?;
    if changes == 0 {
        return Err(super::AppBadRequest::msg("release not found").into());
    }
    drop(db);
    get_release(State(state), Path(id)).await
}

// ─── clients ─────────────────────────────────────────────────────────

pub async fn list_clients(State(state): State<Arc<AppState>>) -> Json<Vec<Value>> {
    let db = state.db.lock().await;
    let rows: Vec<Value> = db
        .conn
        .prepare(
            "SELECT client_id, version, platform, hostname, user_name, first_seen_at, last_seen_at
             FROM app_clients ORDER BY last_seen_at DESC LIMIT 500",
        )
        .ok()
        .and_then(|mut s| {
            s.query_map([], |row| {
                Ok(json!({
                    "client_id": row.get::<_, String>(0)?,
                    "version": row.get::<_, String>(1)?,
                    "platform": row.get::<_, String>(2)?,
                    "hostname": row.get::<_, String>(3)?,
                    "user_name": row.get::<_, String>(4)?,
                    "first_seen_at": row.get::<_, String>(5)?,
                    "last_seen_at": row.get::<_, String>(6)?,
                }))
            })
            .ok()
            .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    Json(rows)
}

pub async fn clear_clients(State(state): State<Arc<AppState>>) -> Json<Value> {
    let db = state.db.lock().await;
    let n = db.conn.execute("DELETE FROM app_clients", []).unwrap_or(0);
    Json(json!({ "ok": true, "deleted": n }))
}

// ─── settings ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct AppSettingsBody {
    pub enabled: Option<bool>,
    pub base_url: Option<String>,
    pub channel: Option<String>,
    pub require_signature: Option<bool>,
    pub pubkey: Option<String>,
}

pub async fn get_settings(State(state): State<Arc<AppState>>) -> Json<Value> {
    let db = state.db.lock().await;
    updater::settings_snapshot(&state.data_dir, &db.conn).into()
}

pub async fn put_settings(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AppSettingsBody>,
) -> Result<Json<Value>, super::AppError> {
    let db = state.db.lock().await;
    let conn = &db.conn;
    if let Some(v) = body.enabled {
        set_setting(conn, updater::SET_ENABLED, v.to_string())?;
    }
    if let Some(v) = body.base_url {
        set_setting(conn, updater::SET_BASE_URL, v.trim().trim_end_matches('/').to_string())?;
    }
    if let Some(v) = body.channel {
        if v.trim().is_empty() {
            return Err(super::AppBadRequest::msg("channel required").into());
        }
        set_setting(conn, updater::SET_CHANNEL, v.trim().to_string())?;
    }
    if let Some(v) = body.require_signature {
        set_setting(conn, updater::SET_REQUIRE_SIG, v.to_string())?;
    }
    if let Some(v) = body.pubkey {
        set_setting(conn, updater::SET_PUBKEY, v.trim().to_string())?;
    }
    Ok(Json(updater::settings_snapshot(&state.data_dir, conn)))
}

fn set_setting(
    conn: &rusqlite::Connection,
    key: &str,
    value: String,
) -> Result<(), super::AppError> {
    conn.execute(
        "INSERT INTO server_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| super::AppBadRequest::msg(e.to_string()))?;
    Ok(())
}

// ─── update preview ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct PreviewQuery {
    pub version: Option<String>,
    pub platform: Option<String>,
    pub arch: Option<String>,
    pub channel: Option<String>,
}

/// GET /api/admin/app/update-preview — как ответит клиенту /api/update/check.
pub async fn update_preview(
    State(state): State<Arc<AppState>>,
    Query(q): Query<PreviewQuery>,
) -> Json<Value> {
    let db = state.db.lock().await;
    let conn = &db.conn;
    let enabled = !updater::falsy(&updater::get_setting(conn, updater::SET_ENABLED).unwrap_or_default());
    if !enabled {
        return Json(json!({ "status": 204, "body": null, "note": "обновления выключены" }));
    }
    let (platform, arch) = match (q.platform.clone(), q.arch.clone()) {
        (Some(p), Some(a)) => (p, a),
        _ => ("linux".to_string(), "x86_64".to_string()),
    };
    let channel = q.channel.unwrap_or_else(|| {
        updater::get_setting(conn, updater::SET_CHANNEL).unwrap_or_else(|| "stable".into())
    });
    let current = q.version.as_deref().and_then(|v| semver::Version::parse(v).ok());
    match updater::best_release(conn, &platform, &arch, &channel, current.as_ref()) {
        Ok(Some(r)) => {
            let base_url = updater::get_setting(conn, updater::SET_BASE_URL)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| crate::opencode::gateway_url_default());
            Json(json!({
                "status": 200,
                "body": {
                    "version": r.version,
                    "notes": r.notes,
                    "pub_date": crate::updater::to_rfc3339(&r.created_at),
                    "url": format!("{}/api/update/download/{}", base_url.trim_end_matches('/'), r.file_name),
                    "signature": r.signature,
                    "required": r.required,
                }
            }))
        }
        Ok(None) => Json(json!({ "status": 204, "body": null, "note": "обновления нет" })),
        Err(e) => Json(json!({ "status": 500, "error": e })),
    }
}

