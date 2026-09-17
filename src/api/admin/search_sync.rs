//! Linkage `config_profiles` → `mcp-1c-search` rows.
//!
//! For every main profile (parent_id IS NULL) with a non-empty path, an
//! `mcp_servers` row `search-<slug>` (`server_type = 'search-auto'`) is
//! maintained: command from template, env regenerated from profiles
//! (`ONEC_CONFIG_PROFILES_JSON` + `ONEC_CONFIG_ACTIVE_PROFILE_ID` +
//! `MINI_AI_1C_SEARCH_INDEX_DIR`), enabled = profile.active.
//! The profile id is stored in `mcp_servers.config` to match rows.
//! Manual `search` rows are never touched. Called after every
//! config_profiles CRUD and once on boot.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};

use super::configs::ConfigProfileRow;
use super::super::AppState;

pub const AUTO_TYPE: &str = "search-auto";
const KEY_PROFILES: &str = "ONEC_CONFIG_PROFILES_JSON";
const KEY_ACTIVE: &str = "ONEC_CONFIG_ACTIVE_PROFILE_ID";
const KEY_INDEX_DIR: &str = "MINI_AI_1C_SEARCH_INDEX_DIR";

fn slug(name: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
            prev_dash = false;
        } else if !prev_dash {
            s.push('-');
            prev_dash = true;
        }
    }
    let s = s.trim_matches('-').to_string();
    let mut s = if s.is_empty() { "cfg".to_string() } else { s };
    s.truncate(40);
    s.trim_end_matches('-').to_string()
}

fn get_setting(db: &crate::db::Database, key: &str) -> Option<String> {
    db.conn
        .query_row(
            "SELECT value FROM server_settings WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .ok()
}

struct Template {
    command: String,
    args: Option<String>,
    extra_env: HashMap<String, String>,
}

/// Template resolution: settings `search_binary` first, else first manual
/// enabled `search` row (its command/args/env extras are reused).
fn resolve_template(db: &crate::db::Database) -> Option<Template> {
    if let Some(bin) = get_setting(db, "search_binary").filter(|s| !s.trim().is_empty()) {
        let args = get_setting(db, "search_args").filter(|s| !s.trim().is_empty());
        return Some(Template {
            command: bin,
            args,
            extra_env: HashMap::new(),
        });
    }
    db.conn
        .query_row(
            "SELECT command, args, env FROM mcp_servers
             WHERE server_type = 'search' AND enabled = 1 AND command IS NOT NULL
             ORDER BY name LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .ok()
        .and_then(|(cmd, args, env)| {
            cmd.map(|command| {
                let extra_env = env
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .and_then(|s| serde_json::from_str::<HashMap<String, String>>(s).ok())
                    .unwrap_or_default();
                Template {
                    command,
                    args,
                    extra_env,
                }
            })
        })
}

fn build_env(
    tpl_extra: &HashMap<String, String>,
    main: &ConfigProfileRow,
    extensions: &[&ConfigProfileRow],
    index_dir: &str,
) -> String {
    let ext_json: Vec<Value> = extensions
        .iter()
        .filter(|e| !e.path.trim().is_empty())
        .map(|e| {
            json!({ "id": e.id, "name": e.name, "path": e.path.trim() })
        })
        .collect();
    let profiles = json!([{
        "id": main.id,
        "name": main.name,
        "main_path": main.path.trim(),
        "extensions": ext_json,
    }]);
    let mut map: HashMap<String, String> = tpl_extra.clone();
    map.insert(
        KEY_PROFILES.to_string(),
        // Pretty (multi-line) — readable in the Admin UI form; stays a JSON
        // *array*, which is what mcp-1c-search parses (single object fails).
        serde_json::to_string_pretty(&profiles).unwrap_or_else(|_| "[]".into()),
    );
    map.insert(KEY_ACTIVE.to_string(), main.id.clone());
    map.insert(KEY_INDEX_DIR.to_string(), index_dir.to_string());
    serde_json::to_string_pretty(&map).unwrap_or_default()
}

struct Desired {
    profile_id: String,
    name: String,
    command: String,
    args: Option<String>,
    env: String,
    enabled: bool,
    description: String,
}

pub async fn resync_search_servers(state: &Arc<AppState>) {
    let (profiles, tpl, index_dir) = {
        let db = state.db.lock().await;
        let profiles = super::configs::load_all(&db);
        let tpl = resolve_template(&db);
        let index_dir = get_setting(&db, "search_index_dir").unwrap_or_else(|| {
            format!("{}/search-index", state.data_dir.trim_end_matches('/'))
        });
        (profiles, tpl, index_dir)
    };

    let tpl = match tpl {
        Some(t) => t,
        None => {
            tracing::warn!(
                "search_sync: no template — set server_settings search_binary \
                 or create one enabled manual 'search' row"
            );
            return;
        }
    };

    let mains: Vec<&ConfigProfileRow> = profiles
        .iter()
        .filter(|p| p.parent_id.is_none() && !p.path.trim().is_empty())
        .collect();

    let mut desired: Vec<Desired> = Vec::new();
    for main in &mains {
        let exts: Vec<&ConfigProfileRow> = profiles
            .iter()
            .filter(|p| p.parent_id.as_deref() == Some(main.id.as_str()))
            .collect();
        desired.push(Desired {
            profile_id: main.id.clone(),
            name: format!("search-{}", slug(&main.name)),
            command: tpl.command.clone(),
            args: tpl.args.clone(),
            env: build_env(&tpl.extra_env, main, &exts, &index_dir),
            enabled: main.active,
            description: format!(
                "Auto from config profile '{}' — edit the profile, not this row",
                main.name
            ),
        });
    }

    // Existing auto rows: (id, config=profile_id, name, command, args, env, enabled).
    let existing: Vec<(String, Option<String>, String, Option<String>, Option<String>, Option<String>, bool)> = {
        let db = state.db.lock().await;
        let mut stmt = match db.conn.prepare(
            "SELECT id, config, name, command, args, env, enabled
             FROM mcp_servers WHERE server_type = ?1",
        ) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("search_sync: {e}");
                return;
            }
        };
        stmt.query_map([AUTO_TYPE], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i32>(6)? != 0,
            ))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    };

    let mut changed_ids: Vec<String> = Vec::new();

    for d in &desired {
        match existing
            .iter()
            .find(|(_, cfg, _, _, _, _, _)| cfg.as_deref() == Some(d.profile_id.as_str()))
        {
            Some((id, _, name, cmd, args, env, enabled)) => {
                if name != &d.name
                    || cmd.as_deref() != Some(d.command.as_str())
                    || args != &d.args
                    || env.as_deref() != Some(d.env.as_str())
                    || *enabled != d.enabled
                {
                    let db = state.db.lock().await;
                    if let Err(e) = db.conn.execute(
                        "UPDATE mcp_servers SET name=?1, command=?2, args=?3, env=?4,
                         enabled=?5, description=?6, updated_at=datetime('now') WHERE id=?7",
                        rusqlite::params![
                            d.name,
                            d.command,
                            d.args,
                            d.env,
                            d.enabled as i32,
                            d.description,
                            id,
                        ],
                    ) {
                        tracing::error!("search_sync update '{id}': {e}");
                        continue;
                    }
                    drop(db);
                    changed_ids.push(id.clone());
                }
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                let db = state.db.lock().await;
                if let Err(e) = db.conn.execute(
                    "INSERT INTO mcp_servers
                     (id, name, description, server_type, transport, command, args, env, enabled, config)
                     VALUES (?1, ?2, ?3, ?4, 'stdio', ?5, ?6, ?7, ?8, ?9)",
                    rusqlite::params![
                        id,
                        d.name,
                        d.description,
                        AUTO_TYPE,
                        d.command,
                        d.args,
                        d.env,
                        d.enabled as i32,
                        d.profile_id,
                    ],
                ) {
                    tracing::error!("search_sync insert '{}': {e}", d.name);
                    continue;
                }
                drop(db);
                tracing::info!("search_sync: created '{}' for profile '{}'", d.name, d.profile_id);
                changed_ids.push(id);
            }
        }
    }

    // Remove auto rows whose profile is gone.
    for (id, cfg, name, _, _, _, _) in &existing {
        if !desired.iter().any(|d| Some(d.profile_id.as_str()) == cfg.as_deref()) {
            let db = state.db.lock().await;
            let _ = db.conn.execute("DELETE FROM mcp_servers WHERE id = ?1", [id]);
            drop(db);
            state.mcp.stop_server(id).await;
            tracing::info!("search_sync: removed orphan '{name}' ({id})");
        }
    }

    for id in changed_ids {
        super::mcp_servers::sync_server(state, &id).await;
    }
}
