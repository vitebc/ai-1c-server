use std::sync::Arc;
use axum::{extract::State, Json};
use serde::Serialize;

use super::super::AppState;

#[derive(Debug, Serialize)]
pub struct ClientRow {
    pub id: String,
    pub name: Option<String>,
    pub version: Option<String>,
    pub last_seen: Option<String>,
    pub config_override: Option<String>,
}

pub async fn list(State(state): State<Arc<AppState>>) -> Json<Vec<ClientRow>> {
    let db = state.db.lock().await;
    let mut stmt = db.conn.prepare(
        "SELECT id, name, version, last_seen, config_override FROM clients ORDER BY last_seen DESC"
    ).unwrap();
    let rows = stmt.query_map([], |row| {
        Ok(ClientRow {
            id: row.get(0)?,
            name: row.get(1)?,
            version: row.get(2)?,
            last_seen: row.get(3)?,
            config_override: row.get(4)?,
        })
    }).unwrap();
    Json(rows.flatten().collect())
}
