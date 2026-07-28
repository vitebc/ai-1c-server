use std::sync::Arc;
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};

use super::super::AppState;
use crate::mcp::{BslLsRelease, BslLsStatus};

#[derive(Debug, Serialize)]
pub struct BslLsState {
    pub status: String,
    pub pid: Option<u32>,
    pub error: Option<String>,
    pub config: BslLsConfigDto,
}

#[derive(Debug, Serialize)]
pub struct VersionsInfo {
    pub java: Option<String>,
    pub bsl_ls_latest: Option<BslLsRelease>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BslLsConfigDto {
    pub java_path: String,
    pub jar_path: String,
    pub port: u16,
    pub enabled: bool,
    pub data_dir: String,
}

pub async fn get_state(State(state): State<Arc<AppState>>) -> Json<BslLsState> {
    let cfg = state.bsl_ls.get_config().await;
    let status = state.bsl_ls.status().await;
    let error = state.bsl_ls.last_error().await;
    let (status_str, pid) = match status {
        BslLsStatus::Running { pid } => ("running".into(), Some(pid)),
        BslLsStatus::Stopped => ("stopped".into(), None),
        BslLsStatus::Error(_) => ("error".into(), None),
    };
    Json(BslLsState {
        status: status_str,
        pid,
        error,
        config: BslLsConfigDto {
            java_path: cfg.java_path,
            jar_path: cfg.jar_path,
            port: cfg.port,
            enabled: cfg.enabled,
            data_dir: cfg.data_dir.clone(),
        },
    })
}

pub async fn get_versions() -> Json<VersionsInfo> {
    let java = crate::mcp::check_java_version().await.ok();
    let bsl_ls_latest = crate::mcp::check_bsl_ls_release().await.ok();
    Json(VersionsInfo { java, bsl_ls_latest })
}

pub async fn download_bsl_ls(
    State(state): State<Arc<AppState>>,
    Path(_version): Path<String>,
) -> Json<serde_json::Value> {
    let release = match crate::mcp::check_bsl_ls_release().await {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({"error": format!("Failed to check release: {}", e)})),
    };
    let jar_url = release.jar_url.as_ref().ok_or("No JAR in release").unwrap();
    let cfg = state.bsl_ls.get_config().await;
    let dest = std::path::Path::new(&cfg.jar_path);
    if let Err(e) = crate::mcp::download_bsl_ls_jar(jar_url, dest).await {
        return Json(serde_json::json!({"error": format!("Download failed: {}", e)}));
    }
    Json(serde_json::json!({"ok": true, "version": release.version, "path": cfg.jar_path}))
}

#[derive(Debug, Deserialize)]
pub struct UpdateConfigReq {
    pub config: Option<BslLsConfigDto>,
}

pub async fn update_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateConfigReq>,
) -> Json<BslLsState> {
    if let Some(cfg) = body.config {
        let new_cfg = crate::mcp::BslLsConfig {
            java_path: cfg.java_path,
            jar_path: cfg.jar_path,
            port: cfg.port,
            enabled: cfg.enabled,
            data_dir: cfg.data_dir.clone(),
        };
        {
            let guard = state.db.lock().await;
            if let Err(e) = new_cfg.save(&*guard) {
                tracing::error!("Failed to save BSL LS config: {}", e);
            }
        }
        state.bsl_ls.update_config(new_cfg).await;
        if cfg.enabled {
            state.bsl_ls.restart().await;
        } else {
            state.bsl_ls.stop().await;
        }
    }
    get_state(State(state)).await
}

pub async fn restart(State(state): State<Arc<AppState>>) -> Json<BslLsState> {
    state.bsl_ls.restart().await;
    get_state(State(state)).await
}

pub async fn stop(State(state): State<Arc<AppState>>) -> Json<BslLsState> {
    state.bsl_ls.stop().await;
    get_state(State(state)).await
}
