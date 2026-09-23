//! MCP HTTP gateway: exposes `mcp_servers` rows as standard MCP endpoints.
//!
//! * `POST /api/mcp/{id|name}/mcp` — Streamable HTTP (JSON-RPC in, JSON out)
//! * `GET  /api/mcp/{id|name}/mcp` — SSE stream (legacy `sse` clients + keep-alive)
//! * `POST /api/mcp-aggregated/mcp` — single entry point: tools of ALL enabled
//!   servers merged with `{server}__{tool}` names
//! * `GET  /api/mcp-aggregated/mcp` — SSE stream for the aggregated endpoint
//!
//! Stateless: every POST is answered inline; `notifications/*` get `202`.
//! `initialize` is answered locally (sessions are already initialized at startup).

use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};

use super::AppState;
use crate::mcp::{JsonRpcRequest, McpError};

static MCP_CHANNEL: once_cell::sync::Lazy<broadcast::Sender<String>> =
    once_cell::sync::Lazy::new(|| {
        let (tx, _) = broadcast::channel(256);
        tx
    });

const PROTOCOL_VERSION: &str = "2025-03-26";

enum Target {
    One(String),
    Aggregated,
}

// ─── Route handlers ─────────────────────────────────────────────────

pub async fn server_rpc(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    handle_rpc(&state, Target::One(key), body).await
}

pub async fn server_sse(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let post_url = absolute_url(&headers, &format!("/api/mcp/{key}/mcp"));
    sse_stream(&state, Target::One(key), &post_url).await
}

pub async fn aggregated_rpc(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    handle_rpc(&state, Target::Aggregated, body).await
}

pub async fn aggregated_sse(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let post_url = absolute_url(&headers, "/api/mcp-aggregated/mcp");
    sse_stream(&state, Target::Aggregated, &post_url).await
}

// ─── REST tools inventory (machine scripts) ───────────────────────────

/// GET /api/mcp-aggregated/tools — flat inventory of all enabled servers:
/// `{ tools: [{ server, server_id, name, full_name, description, inputSchema }], errors: [...] }`.
/// Auth: MCP-gateway zone (API token when token-auth is ON, open when OFF).
pub async fn aggregated_tools(State(state): State<Arc<AppState>>) -> Json<Value> {
    let mut tools = Vec::new();
    let mut errors = Vec::new();
    for (sid, name) in enabled_servers(&state).await {
        let prefix = tool_prefix(&name);
        match state.mcp.list_tools(&sid).await {
            Ok(list) => {
                for t in list {
                    let tname = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    let mut full = format!("{prefix}__{tname}");
                    full.truncate(64);
                    tools.push(json!({
                        "server": name,
                        "server_id": sid,
                        "name": tname,
                        "full_name": full,
                        "description": t.get("description").cloned().unwrap_or(Value::Null),
                        "inputSchema": t.get("inputSchema").cloned().unwrap_or(Value::Null),
                    }));
                }
            }
            Err(e) => {
                errors.push(json!({ "server": name, "server_id": sid, "error": e.to_string() }));
            }
        }
    }
    Json(json!({ "tools": tools, "errors": errors }))
}

/// GET /api/mcp — list enabled MCP servers (gateway zone, API token or open).
/// Returns `[{ id, name, server_type, transport, url }]`.
pub async fn mcp_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let servers = enabled_servers(&state).await;
    Json(json!({ "servers": servers.iter().map(|(id, name)| json!({
        "id": id,
        "name": name,
    })).collect::<Vec<_>>() }))
}

/// GET /api/mcp/{id|name}/tools — inventory of one enabled server.
/// 404 unknown/disabled, 502 not running.
pub async fn server_tools(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
) -> Response {
    let (sid, name) = {
        let db = state.db.lock().await;
        match db.conn.query_row(
            "SELECT id, name FROM mcp_servers WHERE (id = ?1 OR name = ?1) AND enabled = 1",
            [&key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ) {
            Ok(r) => r,
            Err(_) => {
                return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("MCP server '{key}' not found") }))).into_response();
            }
        }
    };
    match state.mcp.list_tools(&sid).await {
        Ok(list) => Json(json!({ "id": sid, "name": name, "tools": list })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

// ─── JSON-RPC dispatch ──────────────────────────────────────────────

async fn handle_rpc(state: &Arc<AppState>, target: Target, body: Value) -> Response {
    if body.is_array() {
        return rpc_error(Value::Null, -32600, "Batch requests not supported");
    }
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let is_notification = body.get("id").is_none();

    // Notifications (no id): acknowledge, no body.
    if is_notification {
        return StatusCode::ACCEPTED.into_response();
    }

    let response = match method {
        "initialize" => json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "ai-1c-server", "version": "0.1.0" }
            }
        }),
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        "tools/list" => match &target {
            Target::One(key) => match resolve_id(state, key).await {
                Some(sid) => proxy_call(state, &sid, id.clone(), body).await,
                None => err_body(id.clone(), -32002, format!("MCP server '{key}' not found")),
            },
            Target::Aggregated => aggregated_list(state, id.clone()).await,
        },
        "tools/call" => match &target {
            Target::One(key) => match resolve_id(state, key).await {
                Some(sid) => proxy_call(state, &sid, id.clone(), body).await,
                None => err_body(id.clone(), -32002, format!("MCP server '{key}' not found")),
            },
            Target::Aggregated => aggregated_call(state, id.clone(), &body).await,
        },
        "resources/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "resources": [] } }),
        "resources/templates/list" => {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "resourceTemplates": [] } })
        }
        "prompts/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "prompts": [] } }),
        _ if method.starts_with("notifications/") => {
            return StatusCode::ACCEPTED.into_response();
        }
        _ => err_body(
            id.clone(),
            -32601,
            format!("Method not found: {method}"),
        ),
    };

    // Fan-out to SSE subscribers (legacy `sse` clients read answers there).
    let _ = MCP_CHANNEL.send(response.to_string());
    Json(response).into_response()
}

fn err_body(id: Value, code: i32, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn rpc_error(id: Value, code: i32, message: &str) -> Response {
    Json(err_body(id, code, message.to_string())).into_response()
}

async fn proxy_call(state: &Arc<AppState>, sid: &str, id: Value, body: Value) -> Value {
    let req: JsonRpcRequest = match serde_json::from_value(body) {
        Ok(r) => r,
        Err(e) => return err_body(id, -32602, format!("Invalid params: {e}")),
    };
    match state.mcp.call(sid, req).await {
        Ok(mut resp) => {
            resp.id = id.clone();
            serde_json::to_value(resp).unwrap_or_else(|e| err_body(id, -32603, e.to_string()))
        }
        Err(McpError::NotFound(_)) => err_body(id, -32002, format!("MCP server '{sid}' is not running")),
        Err(McpError::CallError(msg)) => err_body(id, -32603, msg),
    }
}

// ─── Aggregator ─────────────────────────────────────────────────────

/// `SELECT id, name` of enabled servers, in stable order.
async fn enabled_servers(state: &Arc<AppState>) -> Vec<(String, String)> {
    let db = state.db.lock().await;
    let mut stmt = match db
        .conn
        .prepare("SELECT id, name FROM mcp_servers WHERE enabled = 1 ORDER BY name")
    {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

/// MCP tool names allow `[a-zA-Z0-9_.-]{1,64}` — sanitize server name for prefixing.
pub fn tool_prefix(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        s = "server".into();
    }
    s.truncate(32);
    s
}

async fn aggregated_list(state: &Arc<AppState>, id: Value) -> Value {
    let mut tools = Vec::new();
    for (sid, name) in enabled_servers(state).await {
        let prefix = tool_prefix(&name);
        match state.mcp.list_tools(&sid).await {
            Ok(list) => {
                for mut t in list {
                    if let Some(obj) = t.as_object_mut() {
                        if let Some(n) = obj.get("name").and_then(|n| n.as_str()) {
                            let mut full = format!("{prefix}__{n}");
                            full.truncate(64);
                            obj.insert("name".into(), Value::String(full));
                        }
                        if let Some(d) = obj.get("description").and_then(|d| d.as_str()) {
                            obj.insert(
                                "description".into(),
                                Value::String(format!("[{name}] {d}")),
                            );
                        }
                    }
                    tools.push(t);
                }
            }
            Err(e) => {
                tracing::warn!("aggregated tools/list: server '{sid}' failed: {e}");
            }
        }
    }
    json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } })
}

async fn aggregated_call(state: &Arc<AppState>, id: Value, body: &Value) -> Value {
    let full_name = body
        .get("params")
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("");
    let (prefix, tool) = match full_name.split_once("__") {
        Some((p, t)) if !p.is_empty() && !t.is_empty() => (p, t),
        _ => {
            return err_body(
                id,
                -32602,
                format!("Unknown tool '{full_name}': expected '<server>__<tool>'"),
            )
        }
    };
    let servers = enabled_servers(state).await;
    let sid = servers
        .iter()
        .find(|(_, name)| tool_prefix(name) == prefix)
        .map(|(sid, _)| sid.clone());
    let sid = match sid {
        Some(s) => s,
        None => return err_body(id, -32602, format!("Unknown server prefix '{prefix}'")),
    };
    // Rewrite params.name to the real tool name before proxying.
    let mut body = body.clone();
    if let Some(params) = body.get_mut("params") {
        if let Some(obj) = params.as_object_mut() {
            obj.insert("name".into(), Value::String(tool.to_string()));
        }
    }
    proxy_call(state, &sid, id, body).await
}

// ─── Helpers ────────────────────────────────────────────────────────

/// Accept server id **or** name; returns id of an enabled server.
async fn resolve_id(state: &Arc<AppState>, key: &str) -> Option<String> {
    let db = state.db.lock().await;
    db.conn
        .query_row(
            "SELECT id FROM mcp_servers WHERE (id = ?1 OR name = ?1) AND enabled = 1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .ok()
}

fn absolute_url(headers: &HeaderMap, path: &str) -> String {
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost:9224");
    format!("http://{host}{path}")
}

async fn sse_stream(
    _state: &Arc<AppState>,
    _target: Target,
    post_url: &str,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    // Legacy SSE transport: first event tells the client where to POST.
    let session_id = uuid::Uuid::new_v4().to_string();
    let endpoint = Event::default()
        .event("endpoint")
        .data(format!("{post_url}?sessionId={session_id}"));

    let rx = MCP_CHANNEL.subscribe();
    let messages = BroadcastStream::new(rx).map(|msg| match msg {
        Ok(data) => Ok(Event::default().event("message").data(data)),
        Err(_) => Ok(Event::default().data(String::new())),
    });

    let stream = tokio_stream::iter(vec![Ok(endpoint)]).chain(messages);
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(std::time::Duration::from_secs(15))
            .text("ping"),
    )
}
