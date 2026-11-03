//! Шлюз OpenCode: несколько серверов OpenCode (по одному на базу 1С),
//! единая точка входа для формы 1С, маршрутизация по базе, прокси API/SSE
//! и RLS-мост инструментов 1С.
//!
//! * `admin` — CRUD серверов + управление конфигами/агентами/скилами/тулзами
//!   из админки (`/api/admin/opencode/*`, секция RBAC `opencode`).
//! * `gateway` — listener :9020: прокси OpenCode API (REST/SSE) с реестром
//!   сессий и RLS-мостом `/onec/rpc` для плагина `1c-tools`.

pub mod admin;
pub mod gateway;

use std::path::PathBuf;
use std::sync::Arc;

/// Корень проекта 1C-opencode (конфиги, compose). Дефолт —
/// `/home/test/project/1C-opencode`; переопределяется
/// `server_settings(opencode_project_root)`.
pub fn project_root(db: &crate::db::Database) -> PathBuf {
    let custom: Option<String> = db
        .conn
        .query_row(
            "SELECT value FROM server_settings WHERE key = 'opencode_project_root'",
            [],
            |row| row.get(0),
        )
        .ok();
    match custom {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/root".into());
            PathBuf::from(home).join("project/1C-opencode")
        }
    }
}

/// Адрес шлюза (для формы 1С и UI): `server_settings(opencode_gateway_url)`,
/// дефолт `http://192.168.60.39:9020`.
pub fn gateway_url(db: &crate::db::Database) -> String {
    let custom: Option<String> = db
        .conn
        .query_row(
            "SELECT value FROM server_settings WHERE key = 'opencode_gateway_url'",
            [],
            |row| row.get(0),
        )
        .ok();
    match custom {
        Some(p) if !p.trim().is_empty() => p.trim().trim_end_matches('/').to_string(),
        _ => "http://192.168.60.39:9020".into(),
    }
}

/// Порт listener'а шлюза (env OPENCODE_GATEWAY_PORT, дефолт 9020).
pub fn gateway_port() -> u16 {
    std::env::var("OPENCODE_GATEWAY_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9020)
}

/// Пароль Basic-auth шлюза (форма 1С): `server_settings(opencode_gateway_password)`
/// или env OPENCODE_GATEWAY_PASSWORD. Пусто — шлюз открыт (LAN).
pub fn gateway_password(db: &crate::db::Database) -> Option<String> {
    let from_db: Option<String> = db
        .conn
        .query_row(
            "SELECT value FROM server_settings WHERE key = 'opencode_gateway_password'",
            [],
            |row| row.get(0),
        )
        .ok();
    if let Some(p) = from_db {
        if !p.trim().is_empty() {
            return Some(p);
        }
    }
    std::env::var("OPENCODE_GATEWAY_PASSWORD")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Токен плагина 1c-tools для сервера: HMAC-SHA256(JWT_SECRET, "opencode:<name>").
/// Плагин шлёт его в заголовке X-OpenCode-Token; шлюз сверяет и отдаёт JWT.
pub fn plugin_token(jwt_secret: &str, server_name: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(jwt_secret.as_bytes())
        .expect("hmac: key size is arbitrary");
    mac.update(format!("opencode:{server_name}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Строка Basic-авторизации для OpenCode API.
pub fn basic_auth(username: &str, password: &str) -> String {
    use base64::Engine;
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
    )
}

/// Запуск listener'а шлюза в фоне (основной рантайм). Ошибки бинда — только
/// в лог: админка и MCP не должны падать из-за занятного порта.
pub async fn spawn(state: Arc<crate::api::AppState>) {
    let port = gateway_port();
    tokio::spawn(async move {
        let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                tracing::info!("OpenCode gateway listening on :{port}");
                let app = gateway::app(state.clone());
                if let Err(e) = axum::serve(listener, app.into_make_service()).await {
                    tracing::error!("OpenCode gateway exited: {e}");
                }
            }
            Err(e) => {
                tracing::error!(
                    "OpenCode gateway: cannot bind :{port} ({e}) — шлюз не запущен"
                );
            }
        }
    });
}
