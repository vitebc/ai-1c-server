use std::sync::Arc;
use std::convert::Infallible;
use axum::{
    extract::State,
    response::{
        sse::{Event, Sse},
        Json,
    },
    Json as JsonReq,
};
use futures::stream::Stream;
use tokio_stream::StreamExt;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

use super::AppState;

// Channel for SSE messages
static SSE_CHANNEL: once_cell::sync::Lazy<broadcast::Sender<String>> =
    once_cell::sync::Lazy::new(|| {
        let (tx, _) = broadcast::channel(100);
        tx
    });

/// GET handler — SSE stream for MCP transport
pub async fn sse_handler(
    State(_state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = SSE_CHANNEL.subscribe();
    let stream = BroadcastStream::new(rx).map(|msg| {
        match msg {
            Ok(data) => Ok(Event::default().data(data)),
            Err(_) => Ok(Event::default().data("")),
        }
    });
    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("ping"))
}

/// POST handler — JSON-RPC for MCP tools
pub async fn handle_mcp_skills(
    State(state): State<Arc<AppState>>,
    JsonReq(body): JsonReq<Value>,
) -> Json<Value> {
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(Value::Null);

    let response = match method {
        "tools/list" => handle_list_tools(id),
        "tools/call" => handle_tools_call(id, &body["params"], &state).await,
        _ => make_error(id, -32601, format!("Method not found: {}", method)),
    };

    // Broadcast response via SSE
    let _ = SSE_CHANNEL.send(response.to_string());

    Json(response)
}

// ─── Existing handlers ──────────────────────────────────────────

fn handle_list_tools(id: Value) -> Value {
    json!({
        "jsonrpc": "2.0", "id": id, "result": {
            "tools": [
                { "name": "list_server_skills", "description": "Список всех скилов на сервере", "inputSchema": { "type": "object", "properties": {} } },
                { "name": "get_skill", "description": "Полное содержимое скила", "inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } },
                { "name": "search_skills", "description": "Поиск скилов", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } },
                { "name": "check_skill_updates", "description": "Проверить обновления скилов", "inputSchema": { "type": "object", "properties": { "skills": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "updated_at": { "type": "string" } } } } } } },
                { "name": "export_skills", "description": "ZIP всех скилов (base64)", "inputSchema": { "type": "object", "properties": {} } }
            ]
        }
    })
}

async fn handle_tools_call(id: Value, params: &Value, state: &Arc<AppState>) -> Value {
    let tool = params["name"].as_str().unwrap_or("");
    let args = &params["arguments"];
    match tool {
        "list_server_skills" => handle_list_skills(id, state).await,
        "get_skill" => handle_get_skill(id, args, state).await,
        "search_skills" => handle_search_skills(id, args, state).await,
        "check_skill_updates" => handle_check_updates(id, args, state).await,
        "export_skills" => handle_export_skills(id, state).await,
        _ => make_error(id, -32601, format!("Unknown tool: {}", tool)),
    }
}

fn make_error(id: Value, code: i32, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok_text(id: Value, text: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": text }] } })
}

async fn handle_list_skills(id: Value, state: &Arc<AppState>) -> Value {
    let db = state.db.lock().await;
    let mut stmt = match db.conn.prepare("SELECT id, name, description, category, updated_at FROM skills ORDER BY name") {
        Ok(s) => s,
        Err(e) => return make_error(id, -32603, format!("DB error: {}", e)),
    };
    let rows: Vec<String> = stmt.query_map([], |row| {
        Ok(format!("### {}\nID: `{}`\n{}\nКатегория: {}\nОбновлён: {}",
            row.get::<_, String>(1)?, row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            row.get::<_, String>(4)?))
    }).unwrap().flatten().collect();
    ok_text(id, if rows.is_empty() { "Скилы не найдены".into() } else { rows.join("\n\n") })
}

async fn handle_get_skill(id: Value, args: &Value, state: &Arc<AppState>) -> Value {
    let skill_id = args["id"].as_str().unwrap_or("");
    if skill_id.is_empty() { return make_error(id, -32602, "Parameter 'id' is required".into()); }
    let db = state.db.lock().await;
    match db.conn.query_row(
        "SELECT name, description, instruction, category, metadata, updated_at FROM skills WHERE id = ?1",
        [skill_id],
        |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?, row.get::<_, String>(5)?,
        )),
    ) {
        Ok((name, desc, instr, cat, meta, updated)) => {
            let d = desc.unwrap_or_default();
            let i = instr.unwrap_or_default();
            let c = cat.unwrap_or_default();
            let m = meta.unwrap_or_default();
            let text = format!("# {}\nID: `{}`\nКатегория: {}\nОбновлён: {}\n\n**Описание:** {}\n\n---\n\n{}\n\n{}",
                name, skill_id, c, updated, d, i,
                if m.is_empty() { String::new() } else { format!("---\n**Метаданные:**\n```json\n{}\n```", m) });
            ok_text(id, text)
        }
        Err(_) => ok_text(id, format!("Skill '{}' not found", skill_id)),
    }
}

async fn handle_search_skills(id: Value, args: &Value, state: &Arc<AppState>) -> Value {
    let query = args["query"].as_str().unwrap_or("").to_lowercase();
    let db = state.db.lock().await;
    let mut stmt = db.conn.prepare("SELECT id, name, description FROM skills ORDER BY name").unwrap();
    let results: Vec<String> = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
    }).unwrap().flatten()
    .filter(|(sid, name, desc)| format!("{} {} {}", sid, name, desc.as_deref().unwrap_or("")).to_lowercase().contains(&query))
    .map(|(sid, name, desc)| format!("### {}\nID: `{}`\n{}", name, sid, desc.unwrap_or_default()))
    .collect();
    ok_text(id, if results.is_empty() { format!("По запросу '{}' ничего не найдено", query) } else { results.join("\n\n") })
}

async fn handle_check_updates(id: Value, args: &Value, state: &Arc<AppState>) -> Value {
    let skills_param = match args["skills"].as_array() {
        Some(s) => s,
        None => return ok_text(id, "Parameter 'skills' is required".into()),
    };
    let db = state.db.lock().await;
    let mut changed = Vec::new();
    for s in skills_param {
        let sid = s["id"].as_str().unwrap_or("");
        let client_updated = s["updated_at"].as_str().unwrap_or("");
        if sid.is_empty() { continue; }
        if let Ok(server_updated) = db.conn.query_row::<String, _, _>(
            "SELECT updated_at FROM skills WHERE id = ?1", [sid], |row| row.get(0)
        ) {
            if server_updated.as_str() > client_updated {
                changed.push(format!("{}: обновлён {}", sid, server_updated));
            }
        }
    }
    ok_text(id, if changed.is_empty() { "Все скилы актуальны".into() } else { changed.join("\n") })
}

async fn handle_export_skills(id: Value, state: &Arc<AppState>) -> Value {
    let data_dir = std::path::Path::new(&state.data_dir);
    let skills_dir = data_dir.join("skills");
    let mut zip_buf = Vec::new();
    match crate::api::admin::skills::write_skills_zip(&skills_dir, &mut zip_buf) {
        Ok(()) => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&zip_buf);
            json!({ "jsonrpc": "2.0", "id": id, "result": {
                "content": [{ "type": "text", "text": format!("data:application/zip;base64,{}", b64) }]
            }})
        }
        Err(e) => make_error(id, -32603, format!("ZIP error: {}", e)),
    }
}
