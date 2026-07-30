use std::sync::Arc;
use axum::{extract::State, Json};
use serde_json::{json, Value};

use super::AppState;

pub async fn handle_mcp_skills(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(Value::Null);

    let response = match method {
        "tools/list" => handle_list_tools(id),
        "tools/call" => handle_tools_call(id, &body["params"], &state).await,
        _ => make_error(id, -32601, format!("Method not found: {}", method)),
    };
    Json(response)
}

fn handle_list_tools(id: Value) -> Value {
    json!({
        "jsonrpc": "2.0", "id": id, "result": {
            "tools": [
                {
                    "name": "list_server_skills",
                    "description": "Список всех скилов на сервере с ID, именем, описанием и датой обновления",
                    "inputSchema": { "type": "object", "properties": {} }
                },
                {
                    "name": "get_skill",
                    "description": "Полное содержимое скила: инструкция, описание, метаданные, список файлов",
                    "inputSchema": {
                        "type": "object", "properties": {
                            "id": { "type": "string", "description": "ID скила" }
                        }, "required": ["id"]
                    }
                },
                {
                    "name": "search_skills",
                    "description": "Поиск скилов по названию или описанию",
                    "inputSchema": {
                        "type": "object", "properties": {
                            "query": { "type": "string", "description": "Поисковый запрос" }
                        }, "required": ["query"]
                    }
                },
                {
                    "name": "check_skill_updates",
                    "description": "Проверить обновления скилов по датам",
                    "inputSchema": {
                        "type": "object", "properties": {
                            "skills": {
                                "type": "array",
                                "items": { "type": "object", "properties": {
                                    "id": { "type": "string" },
                                    "updated_at": { "type": "string" }
                                }}
                            }
                        }
                    }
                },
                {
                    "name": "export_skills",
                    "description": "Получить ZIP-архив всех скилов (base64)",
                    "inputSchema": { "type": "object", "properties": {} }
                }
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
        let id: String = row.get(0)?;
        let name: String = row.get(1)?;
        let desc: Option<String> = row.get(2)?;
        let cat: Option<String> = row.get(3)?;
        let updated: String = row.get(4)?;
        let cat_str = cat.as_deref().unwrap_or("");
        let d = desc.as_deref().unwrap_or("");
        Ok(format!("### {}\nID: `{}`\n{}\nКатегория: {}\nОбновлён: {}", name, id, d, cat_str, updated))
    }).unwrap().flatten().collect();
    let text = if rows.is_empty() { "Скилы не найдены".into() } else { rows.join("\n\n") };
    ok_text(id, text)
}

async fn handle_get_skill(id: Value, args: &Value, state: &Arc<AppState>) -> Value {
    let skill_id = args["id"].as_str().unwrap_or("");
    if skill_id.is_empty() { return make_error(id, -32602, "Parameter 'id' is required".into()); }

    let db = state.db.lock().await;
    let row = db.conn.query_row(
        "SELECT name, description, instruction, category, metadata, updated_at FROM skills WHERE id = ?1",
        [skill_id],
        |row| {
            let name: String = row.get(0)?;
            let desc: Option<String> = row.get(1)?;
            let instr: Option<String> = row.get(2)?;
            let cat: Option<String> = row.get(3)?;
            let meta: Option<String> = row.get(4)?;
            let updated: String = row.get(5)?;
            Ok((name, desc, instr, cat, meta, updated))
        },
    );
    match row {
        Ok((name, desc, instr, cat, meta, updated)) => {
            let parts = vec![
                format!("# {}\nID: `{}`\nКатегория: {}\nОбновлён: {}", name, skill_id, cat.unwrap_or_default(), updated),
                format!("**Описание:** {}", desc.unwrap_or_default()),
                format!("---\n{}", instr.unwrap_or_default()),
                if let Some(m) = meta { format!("---\n**Метаданные:**\n```json\n{}\n```", m) } else { String::new() },
            ];
            ok_text(id, parts.iter().filter(|p| !p.is_empty()).cloned().collect::<Vec<_>>().join("\n\n"))
        }
        Err(_) => ok_text(id, format!("Skill '{}' not found", skill_id)),
    }
}

async fn handle_search_skills(id: Value, args: &Value, state: &Arc<AppState>) -> Value {
    let query = args["query"].as_str().unwrap_or("").to_lowercase();
    let db = state.db.lock().await;
    let mut stmt = match db.conn.prepare("SELECT id, name, description, category FROM skills ORDER BY name") {
        Ok(s) => s,
        Err(e) => return make_error(id, -32603, format!("DB error: {}", e)),
    };
    let results: Vec<String> = stmt.query_map([], |row| {
        let skill_id: String = row.get(0)?;
        let name: String = row.get(1)?;
        let desc: Option<String> = row.get(2)?;
        let cat: Option<String> = row.get(3)?;
        Ok((skill_id, name, desc, cat))
    }).unwrap().flatten()
    .filter(|(sid, name, desc, _cat)| {
        let haystack = format!("{} {} {}", sid, name, desc.as_deref().unwrap_or("")).to_lowercase();
        haystack.contains(&query)
    })
    .map(|(sid, name, desc, _cat)| format!("### {}\nID: `{}`\n{}", name, sid, desc.unwrap_or_default()))
    .collect();

    let text = if results.is_empty() { format!("По запросу '{}' ничего не найдено", query) } else { results.join("\n\n") };
    ok_text(id, text)
}

async fn handle_check_updates(id: Value, args: &Value, state: &Arc<AppState>) -> Value {
    let skills_param = args["skills"].as_array();
    if skills_param.is_none() {
        return ok_text(id, "Parameter 'skills' is required".into());
    }
    let skills_param = skills_param.unwrap();

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
    let text = if changed.is_empty() { "Все скилы актуальны".into() } else { changed.join("\n") };
    ok_text(id, text)
}

async fn handle_export_skills(id: Value, state: &Arc<AppState>) -> Value {
    let data_dir = std::path::Path::new(&state.data_dir);
    let skills_dir = data_dir.join("skills");
    let mut zip_buf = Vec::new();
    match crate::api::admin::skills::write_skills_zip(&skills_dir, &mut zip_buf) {
        Ok(()) => {
            let b64 = base64_encode(&zip_buf);
            json!({
                "jsonrpc": "2.0", "id": id, "result": {
                    "content": [{ "type": "text", "text": format!("data:application/zip;base64,{}", b64) }]
                }
            })
        }
        Err(e) => make_error(id, -32603, format!("ZIP error: {}", e)),
    }
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
