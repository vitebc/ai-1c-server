use std::sync::Arc;
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};

use super::super::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelProviderRow {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// Never serialized: list/get expose `api_key_set` instead.
    #[serde(skip_serializing, default)]
    pub api_key: String,
    pub api_key_set: bool,
    pub models: Vec<String>,
    pub enabled: bool,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateProvider {
    pub name: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub models: Option<serde_json::Value>,
    pub enabled: Option<bool>,
    pub is_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProvider {
    pub name: Option<String>,
    pub base_url: Option<String>,
    /// Empty/absent = keep stored key.
    pub api_key: Option<String>,
    pub models: Option<serde_json::Value>,
    pub enabled: Option<bool>,
    pub is_default: Option<bool>,
}

const PROVIDER_COLS: &str =
    "id, name, base_url, api_key, models, enabled, is_default, created_at, updated_at";

fn row_to_provider(row: &rusqlite::Row) -> rusqlite::Result<ModelProviderRow> {
    let models_raw: String = row.get(4)?;
    let models: Vec<String> = serde_json::from_str(&models_raw).unwrap_or_default();
    let api_key: String = row.get(3)?;
    Ok(ModelProviderRow {
        id: row.get(0)?,
        name: row.get(1)?,
        base_url: row.get(2)?,
        api_key_set: !api_key.trim().is_empty(),
        api_key,
        models,
        enabled: row.get::<_, i32>(5)? != 0,
        is_default: row.get::<_, i32>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

/// Accept `["a","b"]` or `"a, b"`; anything else → empty.
fn normalize_models(v: Option<serde_json::Value>) -> Vec<String> {
    match v {
        Some(serde_json::Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        Some(serde_json::Value::String(s)) => s
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn valid_base_url(u: &str) -> bool {
    let t = u.trim();
    !t.is_empty() && (t.starts_with("http://") || t.starts_with("https://"))
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<ModelProviderRow>> {
    let db = state.db.lock().await;
    let mut stmt = db
        .conn
        .prepare(&format!("SELECT {} FROM model_providers ORDER BY name", PROVIDER_COLS))
        .unwrap();
    Json(stmt.query_map([], row_to_provider).unwrap().flatten().collect())
}

pub async fn get_by_id(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ModelProviderRow>, super::NotFound> {
    let db = state.db.lock().await;
    let row = db
        .conn
        .query_row(
            &format!("SELECT {} FROM model_providers WHERE id = ?1", PROVIDER_COLS),
            [&id],
            row_to_provider,
        )
        .map_err(|_| super::NotFound)?;
    Ok(Json(row))
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateProvider>,
) -> Result<Json<ModelProviderRow>, super::AppError> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.len() > 64 {
        return Err(super::AppError::msg("name must be 1..64 chars"));
    }
    let base_url = body.base_url.unwrap_or_default().trim().to_string();
    if !valid_base_url(&base_url) {
        return Err(super::AppError::msg("base_url must start with http:// or https://"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let models = serde_json::to_string(&normalize_models(body.models)).unwrap();
    let enabled = body.enabled.unwrap_or(true) as i32;
    let is_default = body.is_default.unwrap_or(false) as i32;
    let db = state.db.lock().await;
    if let Err(e) = db.conn.execute(
        &format!(
            "INSERT INTO model_providers ({}) VALUES (?1,?2,?3,?4,?5,?6,?7,datetime('now'),datetime('now'))",
            PROVIDER_COLS
        ),
        rusqlite::params![
            id,
            name,
            base_url,
            body.api_key.unwrap_or_default(),
            models,
            enabled,
            is_default,
        ],
    ) {
        let msg = e.to_string();
        if msg.contains("UNIQUE") {
            return Err(super::AppError::msg("provider name already exists"));
        }
        return Err(super::AppError::msg(msg));
    }
    if is_default == 1 {
        let _ = db.conn.execute(
            "UPDATE model_providers SET is_default = 0 WHERE id != ?1",
            [&id],
        );
    }
    drop(db);
    tracing::info!("model-providers: created {name}");
    get_by_id(State(state), Path(id)).await.map_err(Into::into)
}

pub async fn update(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateProvider>,
) -> Result<Json<ModelProviderRow>, super::AppError> {
    let db = state.db.lock().await;
    let existing = db
        .conn
        .query_row(
            &format!("SELECT {} FROM model_providers WHERE id = ?1", PROVIDER_COLS),
            [&id],
            row_to_provider,
        )
        .map_err(|_| super::NotFound)?;

    let name = body.name.unwrap_or(existing.name);
    if name.trim().is_empty() || name.len() > 64 {
        return Err(super::AppError::msg("name must be 1..64 chars"));
    }
    let base_url = body.base_url.unwrap_or(existing.base_url);
    if !valid_base_url(&base_url) {
        return Err(super::AppError::msg("base_url must start with http:// or https://"));
    }
    let api_key = match body.api_key {
        Some(k) if !k.is_empty() => k,
        _ => existing.api_key,
    };
    let models = match body.models {
        Some(v) => serde_json::to_string(&normalize_models(Some(v))).unwrap(),
        None => serde_json::to_string(&existing.models).unwrap(),
    };
    let enabled = body.enabled.unwrap_or(existing.enabled) as i32;
    let is_default = body.is_default.unwrap_or(existing.is_default) as i32;

    if let Err(e) = db.conn.execute(
        "UPDATE model_providers SET name=?1, base_url=?2, api_key=?3, models=?4,
         enabled=?5, is_default=?6, updated_at=datetime('now') WHERE id=?7",
        rusqlite::params![name.trim(), base_url.trim(), api_key, models, enabled, is_default, id],
    ) {
        let msg = e.to_string();
        if msg.contains("UNIQUE") {
            return Err(super::AppError::msg("provider name already exists"));
        }
        return Err(super::AppError::msg(msg));
    }
    if is_default == 1 {
        let _ = db.conn.execute(
            "UPDATE model_providers SET is_default = 0 WHERE id != ?1",
            [&id],
        );
    }
    drop(db);
    tracing::info!("model-providers: updated {id}");
    get_by_id(State(state), Path(id)).await.map_err(Into::into)
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, super::AppError> {
    let db = state.db.lock().await;
    let changes = db.conn.execute("DELETE FROM model_providers WHERE id = ?1", [&id])?;
    if changes == 0 {
        return Err(super::NotFound.into());
    }
    drop(db);
    tracing::warn!("model-providers: deleted {id}");
    Ok(Json(()))
}

/// POST /model-providers/{id}/probe — GET {base_url}/models with the stored
/// key (OpenAI shape `{data:[{id}]}`; falls back to a plain string array).
pub async fn probe(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, super::AppError> {
    let (base_url, api_key) = {
        let db = state.db.lock().await;
        db.conn
            .query_row(
                "SELECT base_url, api_key FROM model_providers WHERE id = ?1",
                [&id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|_| super::NotFound)?
    };
    drop(state);
    Ok(Json(fetch_models(&base_url, &api_key).await))
}

#[derive(Debug, Deserialize)]
pub struct ProbeBody {
    pub base_url: String,
    pub api_key: Option<String>,
}

/// POST /model-providers/probe — same probe for an unsaved form
/// (`{base_url, api_key?}`), used for live model multiselect.
pub async fn probe_adhoc(Json(body): Json<ProbeBody>) -> Json<serde_json::Value> {
    Json(fetch_models(&body.base_url, body.api_key.as_deref().unwrap_or("")).await)
}

async fn fetch_models(base_url: &str, api_key: &str) -> serde_json::Value {
    let fail = |e: String| serde_json::json!({ "ok": false, "models": [], "error": e });
    let url = format!("{}/models", base_url.trim().trim_end_matches('/'));
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => return fail(e.to_string()),
    };
    let mut req = client.get(&url);
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return fail(format!("probe {url}: {e}")),
    };
    if !resp.status().is_success() {
        return fail(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    let mut models: Vec<String> = body
        .get("data")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("id").and_then(|i| i.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if models.is_empty() {
        if let Some(a) = body.as_array() {
            models = a
                .iter()
                .filter_map(|x| x.as_str())
                .map(str::to_string)
                .collect();
        }
    }
    serde_json::json!({ "ok": true, "models": models })
}

/// GET /model-providers/options — `{providers: [{name, default_model}]}` for
/// the future agent model picker. No keys leak; any agent file-area holder.
pub async fn options(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let rows: Vec<(String, Vec<String>, bool)> = {
        let db = state.db.lock().await;
        let prepared = db.conn.prepare(
            "SELECT name, models, is_default FROM model_providers WHERE enabled = 1 ORDER BY name",
        );
        match prepared {
            Ok(mut stmt) => stmt
                .query_map([], |row| {
                    let raw: String = row.get(1)?;
                    let models: Vec<String> =
                        serde_json::from_str(&raw).unwrap_or_default();
                    Ok((row.get::<_, String>(0)?, models, row.get::<_, i32>(2)? != 0))
                })
                .map(|r| r.flatten().collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    };
    Json(serde_json::json!({
        "providers": rows.into_iter().map(|(name, models, is_default)| {
            serde_json::json!({
                "name": name,
                "default_model": models.first(),
                "models": models,
                "is_default": is_default,
            })
        }).collect::<Vec<_>>(),
    }))
}
