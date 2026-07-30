use std::sync::Arc;
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;

use super::AppState;

mod bsl_ls;
mod client_versions;
mod clients;
mod configs;
mod mcp_servers;
pub mod skills;

#[derive(Debug)]
pub struct NotFound;

impl IntoResponse for NotFound {
    fn into_response(self) -> axum::response::Response {
        (StatusCode::NOT_FOUND, "Not found").into_response()
    }
}

#[derive(Debug)]
pub struct AppError(Box<dyn std::error::Error>);

impl<T: Into<Box<dyn std::error::Error>>> From<T> for AppError {
    fn from(err: T) -> Self {
        Self(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        tracing::error!("Admin API error: {}", self.0);
        (StatusCode::INTERNAL_SERVER_ERROR, self.0.to_string()).into_response()
    }
}

impl From<NotFound> for AppError {
    fn from(_: NotFound) -> Self {
        AppError("Not found".into())
    }
}

#[derive(Debug, Serialize)]
struct McpServerStatus {
    id: String,
    name: String,
    status: String,
}

async fn status(State(state): State<Arc<AppState>>) -> Json<Vec<McpServerStatus>> {
    let db = state.db.lock().await;
    let mut stmt = db.conn.prepare(
        "SELECT id, name FROM mcp_servers WHERE enabled = 1 ORDER BY name"
    ).unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(McpServerStatus {
            id: row.get(0)?,
            name: row.get(1)?,
            status: "unknown".into(),
        })
    }).unwrap();
    Json(rows.flatten().collect())
}

async fn logs() -> Json<Vec<serde_json::Value>> {
    Json(Vec::new())
}

async fn reindex() -> &'static str {
    "Reindex triggered (stub)"
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/mcp-servers", get(mcp_servers::list).post(mcp_servers::create))
        .route("/mcp-servers/{id}", get(mcp_servers::get_by_id).put(mcp_servers::update).delete(mcp_servers::delete))
        .route("/skills", get(skills::list).post(skills::create))
        .route("/skills/{id}", get(skills::get_by_id).put(skills::update).delete(skills::delete))
        .route("/skills/import", post(skills::import_skills))
        .route("/skills/upload", post(skills::upload_skills))
        .route("/skills/export", get(skills::export_skills))
        .route("/config-profiles", get(configs::list).post(configs::create))
        .route("/config-profiles/{id}", get(configs::get_by_id).put(configs::update).delete(configs::delete))
        .route("/client-versions", get(client_versions::list).post(client_versions::create))
        .route("/client-versions/{id}", get(client_versions::get_by_id).put(client_versions::update).delete(client_versions::delete))
        .route("/clients", get(clients::list))
        .route("/status", get(status))
        .route("/logs", get(logs))
        .route("/reindex", post(reindex))
        .route("/bsl-ls", get(bsl_ls::get_state))
        .route("/bsl-ls/config", post(bsl_ls::update_config))
        .route("/bsl-ls/restart", post(bsl_ls::restart))
        .route("/bsl-ls/stop", post(bsl_ls::stop))
        .route("/bsl-ls/install-java", post(bsl_ls::install_java_endpoint))
        .route("/bsl-ls/logs", get(bsl_ls::get_logs))
        .route("/bsl-ls/logs/clear", post(bsl_ls::clear_logs_endpoint))
        .route("/bsl-ls/versions", get(bsl_ls::get_versions))
        .route("/bsl-ls/download/{version}", post(bsl_ls::download_bsl_ls))
}
