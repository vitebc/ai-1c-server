use std::sync::Arc;
use axum::{
    extract::State,
    Json,
};
use serde::{Deserialize, Serialize};

use super::super::AppState;
use crate::mcp::BslLsStatus;

#[derive(Debug, Serialize)]
pub struct BslLsState {
    pub status: String,
    pub pid: Option<u32>,
    pub config: BslLsConfigDto,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BslLsConfigDto {
    pub java_path: String,
    pub jar_path: String,
    pub port: u16,
    pub enabled: bool,
}

pub async fn get_state(State(state): State<Arc<AppState>>) -> Json<BslLsState> {
    let cfg = state.bsl_ls.get_config().await;
    let status = state.bsl_ls.status().await;
    let (status_str, pid) = match status {
        BslLsStatus::Running { pid } => ("running".into(), Some(pid)),
        BslLsStatus::Stopped => ("stopped".into(), None),
        BslLsStatus::Error(e) => (format!("error: {}", e), None),
    };
    Json(BslLsState {
        status: status_str,
        pid,
        config: BslLsConfigDto {
            java_path: cfg.java_path,
            jar_path: cfg.jar_path,
            port: cfg.port,
            enabled: cfg.enabled,
        },
    })
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
        };
        {
            let guard = state.db.lock().await;
            if let Err(e) = new_cfg.save(&*guard) {
                tracing::error!("Failed to save BSL LS config: {}", e);
            }
        }
        state.bsl_ls.update_config(new_cfg).await;
        if cfg.enabled {
            if let Err(e) = state.bsl_ls.restart().await {
                tracing::error!("Failed to restart BSL LS: {}", e);
            }
        } else {
            state.bsl_ls.stop().await;
        }
    }
    get_state(State(state)).await
}

pub async fn restart(State(state): State<Arc<AppState>>) -> Json<BslLsState> {
    let _ = state.bsl_ls.restart().await;
    get_state(State(state)).await
}

pub async fn stop(State(state): State<Arc<AppState>>) -> Json<BslLsState> {
    state.bsl_ls.stop().await;
    get_state(State(state)).await
}
